#pragma once

#include "formats/bytes.hpp"

#include <cstdint>
#include <functional>
#include <vector>

namespace nslib {

constexpr uint64_t kNczPrefixSize = 0x4000;
constexpr uint64_t kNczMaxAppletWindow = 32ull * 1024ull * 1024ull;
constexpr uint64_t kNczMaxOverrideWindow = 128ull * 1024ull * 1024ull;

enum class NczCryptoType : uint64_t {
    None = 1,
    Xts = 2,
    Ctr = 3,
    Bktr = 4,
};

struct NczSection {
    uint64_t offset = 0;
    uint64_t size = 0;
    uint64_t cryptoType = 0;
    uint8_t cryptoKey[16]{};
    uint8_t cryptoCounter[16]{};
};

struct NczBlockInfo {
    uint8_t version = 0;
    uint8_t type = 0;
    uint8_t blockSizeExponent = 0;
    uint32_t blockSize = 0;
    uint64_t decompressedSize = 0;
    std::vector<uint32_t> compressedBlockSizes;
};

struct NczHeader {
    std::vector<NczSection> sections;
    bool hasBlock = false;
    NczBlockInfo block;
    uint64_t dataOffset = 0;
};

class SeqSource {
public:
    virtual ~SeqSource() = default;
    /** Read up to `n` bytes. Returns 0 at EOF. */
    virtual size_t read(void* dst, size_t n) = 0;
};

NczHeader parseNczHeader(const Reader& reader);

/** Decompressed NCA size implied by the section table. */
uint64_t nczOutputSize(const NczHeader& h);

/**
 * Stream an NCZ into `out` (plaintext NCA, re-encrypted). `maxWindow` is the zstd window
 * budget; applet mode should pass `kNczMaxAppletWindow`.
 */
void decodeNcz(SeqSource& in, const std::function<void(const uint8_t*, size_t)>& out, uint64_t maxWindow);

/** Restore a full NCA from an NCZ reader. */
std::vector<uint8_t> decompressNczToBuffer(const Reader& reader, uint64_t maxWindow = kNczMaxOverrideWindow);

} // namespace nslib
