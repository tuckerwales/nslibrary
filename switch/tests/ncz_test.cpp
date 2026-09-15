#include "api/json.hpp"
#include "formats/container.hpp"
#include "formats/crypto.hpp"
#include "formats/ncz.hpp"
#include "test.hpp"

using namespace nslib;

static std::vector<uint8_t> restore(const char* file) {
    const auto bytes = slurpBytes(fixturePath(file));
    return decompressNczToBuffer(MemoryReader(bytes));
}

TEST(ncz_solid_restores_nca) {
    const auto nca = slurpBytes(fixturePath("nca.bin"));
    const auto restored = restore("ncz-solid.bin");
    CHECK_EQ(restored.size(), nca.size());
    CHECK(restored == nca);
}

TEST(ncz_block_restores_nca) {
    const auto nca = slurpBytes(fixturePath("nca.bin"));
    const auto restored = restore("ncz-block.bin");
    CHECK_EQ(restored.size(), nca.size());
    CHECK(restored == nca);
}

TEST(ncz_header_sections) {
    const auto bytes = slurpBytes(fixturePath("ncz-solid.bin"));
    const auto expect = Json::parse(slurpFile(fixturePath("expected.json")));
    const NczHeader h = parseNczHeader(MemoryReader(bytes));
    CHECK(!h.hasBlock);
    CHECK_EQ(h.sections.size(), expect["ncz"]["sections"].size());
    CHECK_EQ(nczOutputSize(h), expect["ncz"]["ncaSize"].asUint());
}

TEST(ncz_block_header) {
    const auto bytes = slurpBytes(fixturePath("ncz-block.bin"));
    const NczHeader h = parseNczHeader(MemoryReader(bytes));
    CHECK(h.hasBlock);
    CHECK_EQ(h.block.blockSize, 0x4000u);
    CHECK(h.block.compressedBlockSizes.size() > 1u);
}

TEST(ncz_rejects_plain_nca) {
    const auto nca = slurpBytes(fixturePath("nca.bin"));
    bool threw = false;
    try {
        parseNczHeader(MemoryReader(nca));
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("BAD_MAGIC"));
    }
    CHECK(threw);
}

TEST(ncz_rejects_xts_section) {
    auto bytes = slurpBytes(fixturePath("ncz-solid.bin"));
    // cryptoType is u64 at section 0 offset 0x10 within the first section entry.
    writeU64(bytes.data() + 0x4000 + 0x10 + 0x10, 2);
    bool threw = false;
    try {
        parseNczHeader(MemoryReader(bytes));
    } catch (const FormatError& e) {
        threw = true;
        CHECK_EQ(e.code, std::string("UNSUPPORTED"));
    }
    CHECK(threw);
}

TEST(nsp_nsz_identical_content_ids) {
    const auto expect = Json::parse(slurpFile(fixturePath("expected.json")));
    const auto nsp = slurpBytes(fixturePath("nsp-identity.bin"));
    const auto nsz = slurpBytes(fixturePath("nsz-identity.bin"));
    const Partition nspP = listInstallEntries(MemoryReader(nsp), "nsp");
    const Partition nszP = listInstallEntries(MemoryReader(nsz), "nsz");
    CHECK_EQ(nspP.entries.size(), nszP.entries.size());
    CHECK(nspP.entries[1].kind == EntryKind::Nca);
    CHECK(nszP.entries[1].kind == EntryKind::Ncz);

    MemoryReader nszReader(nsz);
    MemoryReader nspReader(nsp);
    SliceReader nczSlice(nszReader, nszP.entries[1].offset, nszP.entries[1].size);
    const auto restored = decompressNczToBuffer(nczSlice);
    const auto nca = nspReader.readExact(nspP.entries[1].offset, size_t(nspP.entries[1].size));
    CHECK(restored == nca);

    const auto hash = sha256(restored.data(), restored.size());
    CHECK_EQ(hexLower(hash.data(), 32), expect["ncz"]["ncaSha256"].asString());
    CHECK_EQ(hexLower(hash.data(), 16), expect["ncz"]["ncaId"].asString());
    CHECK_EQ(nszP.entries[1].name.substr(0, 32), expect["ncz"]["ncaId"].asString());
    CHECK_EQ(nspP.entries[1].name.substr(0, 32), expect["ncz"]["ncaId"].asString());
}
