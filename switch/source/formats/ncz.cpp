#include "formats/ncz.hpp"

#include "formats/crypto.hpp"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#define ZSTD_STATIC_LINKING_ONLY
#include <zstd.h>

namespace nslib {
namespace {

constexpr size_t kSectionTableHeader = 0x10;
constexpr size_t kSectionEntrySize = 0x40;
constexpr size_t kBlockHeaderSize = 0x18;
constexpr uint64_t kMaxSections = 64;
constexpr uint8_t kMinBlockExp = 14;
constexpr uint8_t kMaxBlockExp = 32;

void readFull(SeqSource& in, void* dst, size_t n) {
    auto* p = static_cast<uint8_t*>(dst);
    size_t got = 0;
    while (got < n) {
        const size_t m = in.read(p + got, n - got);
        if (m == 0) throw FormatError("TRUNCATED", "NCZ ended early");
        got += m;
    }
}

class ReaderSeq : public SeqSource {
public:
    explicit ReaderSeq(const Reader& r) : r_(&r) {}
    size_t read(void* dst, size_t n) override {
        if (pos_ >= r_->size()) return 0;
        if (pos_ + n > r_->size()) n = size_t(r_->size() - pos_);
        if (n) r_->read(pos_, dst, n);
        pos_ += n;
        return n;
    }

private:
    const Reader* r_;
    uint64_t pos_ = 0;
};

const NczSection* sectionAt(const std::vector<NczSection>& sections, uint64_t offset) {
    for (const auto& s : sections) {
        if (offset >= s.offset && offset < s.offset + s.size) return &s;
    }
    return nullptr;
}

void applyCrypto(const std::vector<NczSection>& sections, uint64_t offset, uint8_t* data, size_t n) {
    size_t i = 0;
    while (i < n) {
        const NczSection* s = sectionAt(sections, offset);
        size_t take = n - i;
        if (s) {
            take = std::min(take, size_t(s->offset + s->size - offset));
            if (s->cryptoType == uint64_t(NczCryptoType::Ctr) || s->cryptoType == uint64_t(NczCryptoType::Bktr)) {
                aesCtrXor(s->cryptoKey, s->cryptoCounter, offset, data + i, take);
            }
        } else {
            uint64_t next = UINT64_MAX;
            for (const auto& sec : sections) {
                if (sec.offset > offset && sec.offset < next) next = sec.offset;
            }
            if (next != UINT64_MAX) take = std::min(take, size_t(next - offset));
        }
        offset += take;
        i += take;
    }
}

NczHeader parseTable(const uint8_t* tableHdr, const uint8_t* entries, uint64_t tableOffset) {
    if (std::memcmp(tableHdr, "NCZSECTN", 8) != 0) {
        throw FormatError("BAD_MAGIC", "no NCZSECTN table at " + hexOffset(tableOffset));
    }
    const uint64_t count = readU64(tableHdr + 8);
    if (count == 0 || count > kMaxSections) {
        throw FormatError("INVALID", "NCZ declares " + std::to_string(count) + " sections");
    }
    NczHeader h;
    h.sections.reserve(size_t(count));
    for (uint64_t i = 0; i < count; i++) {
        const uint8_t* e = entries + i * kSectionEntrySize;
        NczSection s;
        s.offset = readU64(e);
        s.size = readU64(e + 8);
        s.cryptoType = readU64(e + 0x10);
        std::memcpy(s.cryptoKey, e + 0x20, 16);
        std::memcpy(s.cryptoCounter, e + 0x30, 16);
        if (s.cryptoType == uint64_t(NczCryptoType::Xts) || s.cryptoType > uint64_t(NczCryptoType::Bktr)) {
            throw FormatError("UNSUPPORTED", "NCZ section " + std::to_string(i) + " uses crypto type " +
                std::to_string(s.cryptoType));
        }
        h.sections.push_back(s);
    }
    h.dataOffset = tableOffset + kSectionTableHeader + count * kSectionEntrySize;
    return h;
}

void parseBlockHeader(NczHeader& h, const uint8_t* hdr, const uint8_t* sizes) {
    h.hasBlock = true;
    h.block.version = hdr[0x08];
    h.block.type = hdr[0x09];
    h.block.blockSizeExponent = hdr[0x0b];
    if (h.block.blockSizeExponent < kMinBlockExp || h.block.blockSizeExponent > kMaxBlockExp) {
        throw FormatError("INVALID",
            "NCZ block size exponent " + std::to_string(h.block.blockSizeExponent) + " out of range");
    }
    h.block.blockSize = 1u << h.block.blockSizeExponent;
    const uint32_t blockCount = readU32(hdr + 0x0c);
    h.block.decompressedSize = readU64(hdr + 0x10);
    const uint64_t expectCount = (h.block.decompressedSize + h.block.blockSize - 1) / h.block.blockSize;
    if (blockCount != expectCount) {
        throw FormatError("INVALID", "NCZ has " + std::to_string(blockCount) + " blocks for " +
            std::to_string(h.block.decompressedSize) + " bytes at " + std::to_string(h.block.blockSize) + "/block");
    }
    h.block.compressedBlockSizes.resize(blockCount);
    uint64_t compressedTotal = 0;
    for (uint32_t i = 0; i < blockCount; i++) {
        h.block.compressedBlockSizes[i] = readU32(sizes + i * 4);
        compressedTotal += h.block.compressedBlockSizes[i];
    }
    h.dataOffset += kBlockHeaderSize + uint64_t(blockCount) * 4;
    (void)compressedTotal;
}

void emitBody(const NczHeader& h, uint64_t& ncaOffset, uint8_t* data, size_t n,
    const std::function<void(const uint8_t*, size_t)>& out)
{
    applyCrypto(h.sections, ncaOffset, data, n);
    out(data, n);
    ncaOffset += n;
}

void checkFrameWindow(const uint8_t* src, size_t n, uint64_t maxWindow) {
    ZSTD_frameHeader fh{};
    const size_t need = ZSTD_getFrameHeader(&fh, src, n);
    if (ZSTD_isError(need)) {
        throw FormatError("INVALID", std::string("NCZ zstd frame: ") + ZSTD_getErrorName(need));
    }
    if (need != 0) return;
    if (fh.windowSize > maxWindow) {
        throw FormatError("UNSUPPORTED",
            "This NSZ needs more memory. Launch NSLibrary while holding R over a game (title override).");
    }
}

void decodeSolid(SeqSource& in, const uint8_t* first, size_t firstN, const NczHeader& h, uint64_t maxWindow,
    const std::function<void(const uint8_t*, size_t)>& out)
{
    // Owned by unique_ptr: `out` can throw (cancel, write failure) and the window can be 128 MB.
    std::unique_ptr<ZSTD_DCtx, size_t (*)(ZSTD_DCtx*)> owned(ZSTD_createDCtx(), ZSTD_freeDCtx);
    ZSTD_DCtx* dctx = owned.get();
    if (!dctx) throw FormatError("INTERNAL", "ZSTD_createDCtx failed");
    ZSTD_DCtx_setParameter(dctx, ZSTD_d_windowLogMax, 27);

    std::vector<uint8_t> inBuf(1 << 16);
    std::vector<uint8_t> outBuf(1 << 16);
    if (firstN) std::memcpy(inBuf.data(), first, firstN);
    size_t filled = firstN;
    bool headerChecked = false;
    uint64_t ncaOffset = kNczPrefixSize;
    bool finished = false;

    auto consume = [&](ZSTD_inBuffer& zin) {
        while (zin.pos < zin.size) {
            ZSTD_outBuffer zout{outBuf.data(), outBuf.size(), 0};
            const size_t ret = ZSTD_decompressStream(dctx, &zout, &zin);
            if (ZSTD_isError(ret)) {
                throw FormatError("INVALID", std::string("NCZ zstd: ") + ZSTD_getErrorName(ret));
            }
            if (zout.pos) emitBody(h, ncaOffset, outBuf.data(), zout.pos, out);
            if (ret == 0) {
                finished = true;
                break;
            }
        }
    };

    while (!finished) {
        if (filled < inBuf.size()) {
            const size_t got = in.read(inBuf.data() + filled, inBuf.size() - filled);
            filled += got;
            if (got == 0 && filled == 0) break;
        }
        if (!headerChecked && filled >= 18) {
            checkFrameWindow(inBuf.data(), filled, maxWindow);
            headerChecked = true;
        }
        ZSTD_inBuffer zin{inBuf.data(), filled, 0};
        consume(zin);
        const size_t leftover = filled - zin.pos;
        if (leftover && zin.pos) std::memmove(inBuf.data(), inBuf.data() + zin.pos, leftover);
        filled = leftover;
        if (zin.pos == 0 && leftover == inBuf.size()) {
            // Need a bigger input buffer to make progress.
            inBuf.resize(inBuf.size() * 2);
        }
        if (zin.size == leftover && leftover < inBuf.size()) {
            const size_t got = in.read(inBuf.data() + filled, inBuf.size() - filled);
            if (got == 0) {
                // Flush remaining with empty input.
                ZSTD_inBuffer empty{nullptr, 0, 0};
                while (!finished) {
                    ZSTD_outBuffer zout{outBuf.data(), outBuf.size(), 0};
                    const size_t ret = ZSTD_decompressStream(dctx, &zout, &empty);
                    if (ZSTD_isError(ret)) {
                        throw FormatError("INVALID", std::string("NCZ zstd: ") + ZSTD_getErrorName(ret));
                    }
                    if (zout.pos) emitBody(h, ncaOffset, outBuf.data(), zout.pos, out);
                    if (ret == 0 || zout.pos == 0) break;
                }
                break;
            }
            filled += got;
        }
    }
}

void decodeBlocks(SeqSource& in, const NczHeader& h, const std::function<void(const uint8_t*, size_t)>& out) {
    uint64_t remaining = h.block.decompressedSize;
    uint64_t ncaOffset = kNczPrefixSize;
    for (size_t i = 0; i < h.block.compressedBlockSizes.size(); i++) {
        const uint32_t storedSize = h.block.compressedBlockSizes[i];
        const uint32_t expected = uint32_t(std::min(uint64_t(h.block.blockSize), remaining));
        if (storedSize > expected) {
            throw FormatError("INVALID", "NCZ block " + std::to_string(i) + " stored size exceeds decompressed size");
        }
        std::vector<uint8_t> stored(storedSize);
        if (storedSize) readFull(in, stored.data(), storedSize);
        std::vector<uint8_t> raw(expected);
        if (storedSize < expected) {
            const size_t d = ZSTD_decompress(raw.data(), raw.size(), stored.data(), stored.size());
            if (ZSTD_isError(d) || d != expected) {
                throw FormatError("INVALID", "NCZ block " + std::to_string(i) + " decompressed to " +
                    std::to_string(ZSTD_isError(d) ? 0 : d) + " bytes, expected " + std::to_string(expected));
            }
        } else {
            if (expected) std::memcpy(raw.data(), stored.data(), expected);
        }
        if (expected) emitBody(h, ncaOffset, raw.data(), expected, out);
        remaining -= expected;
    }
}

} // namespace

NczHeader parseNczHeader(const Reader& reader) {
    const uint64_t tableOffset = kNczPrefixSize;
    auto fixed = reader.readExact(tableOffset, kSectionTableHeader);
    if (std::memcmp(fixed.data(), "NCZSECTN", 8) != 0) {
        throw FormatError("BAD_MAGIC", "no NCZSECTN table at " + hexOffset(tableOffset));
    }
    const uint64_t count = readU64(fixed.data() + 8);
    if (count == 0 || count > kMaxSections) {
        throw FormatError("INVALID", "NCZ declares " + std::to_string(count) + " sections");
    }
    auto table = reader.readExact(tableOffset + kSectionTableHeader, size_t(count * kSectionEntrySize));
    NczHeader h = parseTable(fixed.data(), table.data(), tableOffset);

    if (h.dataOffset + 8 > reader.size()) {
        throw FormatError("TRUNCATED", "NCZ has no compressed data");
    }
    auto peek = reader.readExact(h.dataOffset, 8);
    if (std::memcmp(peek.data(), "NCZBLOCK", 8) != 0) return h;

    auto blockHeader = reader.readExact(h.dataOffset, kBlockHeaderSize);
    const uint32_t blockCount = readU32(blockHeader.data() + 0x0c);
    auto sizes = reader.readExact(h.dataOffset + kBlockHeaderSize, blockCount * 4);
    parseBlockHeader(h, blockHeader.data(), sizes.data());
    uint64_t compressedTotal = 0;
    for (uint32_t s : h.block.compressedBlockSizes) compressedTotal += s;
    if (h.dataOffset + compressedTotal > reader.size()) {
        throw FormatError("TRUNCATED", "NCZ block data extends past end of file");
    }
    return h;
}

uint64_t nczOutputSize(const NczHeader& h) {
    uint64_t end = kNczPrefixSize;
    for (const auto& s : h.sections) end = std::max(end, s.offset + s.size);
    return end;
}

void decodeNcz(SeqSource& in, const std::function<void(const uint8_t*, size_t)>& out, uint64_t maxWindow) {
    std::vector<uint8_t> prefix(static_cast<size_t>(kNczPrefixSize));
    readFull(in, prefix.data(), prefix.size());
    out(prefix.data(), prefix.size());

    uint8_t tableHdr[kSectionTableHeader];
    readFull(in, tableHdr, sizeof(tableHdr));
    const uint64_t count = readU64(tableHdr + 8);
    if (count == 0 || count > kMaxSections) {
        throw FormatError("INVALID", "NCZ declares " + std::to_string(count) + " sections");
    }
    std::vector<uint8_t> entries(size_t(count * kSectionEntrySize));
    readFull(in, entries.data(), entries.size());
    NczHeader h = parseTable(tableHdr, entries.data(), kNczPrefixSize);

    uint8_t peek[8];
    readFull(in, peek, 8);
    if (std::memcmp(peek, "NCZBLOCK", 8) == 0) {
        uint8_t rest[kBlockHeaderSize - 8];
        readFull(in, rest, sizeof(rest));
        uint8_t hdr[kBlockHeaderSize];
        std::memcpy(hdr, peek, 8);
        std::memcpy(hdr + 8, rest, sizeof(rest));
        const uint32_t blockCount = readU32(hdr + 0x0c);
        std::vector<uint8_t> sizes(blockCount * 4);
        readFull(in, sizes.data(), sizes.size());
        parseBlockHeader(h, hdr, sizes.data());
        decodeBlocks(in, h, out);
        return;
    }
    decodeSolid(in, peek, 8, h, maxWindow, out);
}

std::vector<uint8_t> decompressNczToBuffer(const Reader& reader, uint64_t maxWindow) {
    ReaderSeq seq(reader);
    std::vector<uint8_t> out;
    const auto header = parseNczHeader(reader);
    out.reserve(size_t(nczOutputSize(header)));
    decodeNcz(seq, [&](const uint8_t* p, size_t n) { out.insert(out.end(), p, p + n); }, maxWindow);
    return out;
}

} // namespace nslib
