#pragma once

#include "formats/cnmt.hpp"

#include <vector>

namespace nslib {

/** Packed like libnx `NcmContentMetaHeader`. */
struct ContentMetaHeader {
    uint16_t extendedHeaderSize;
    uint16_t contentCount;
    uint16_t contentMetaCount;
    uint8_t attributes;
    uint8_t storageId;
};

/** Packed like libnx `NcmContentInfo`. */
struct ContentInfo {
    uint8_t contentId[16];
    uint32_t sizeLow;
    uint8_t sizeHigh;
    uint8_t attr;
    uint8_t contentType;
    uint8_t idOffset;
};

static_assert(sizeof(ContentMetaHeader) == 8, "NcmContentMetaHeader is 8 bytes");
static_assert(sizeof(ContentInfo) == 0x18, "NcmContentInfo is 0x18 bytes");

inline void contentInfoSetSize(ContentInfo& info, uint64_t size) {
    info.sizeLow = uint32_t(size);
    info.sizeHigh = uint8_t(size >> 32);
}

/**
 * Build the blob passed to `ncmContentMetaDatabaseSet`: header, extended header,
 * `NcmContentInfo[]` (packaged records plus the meta NCA itself), optional digest.
 * Delta fragments are dropped.
 */
std::vector<uint8_t> buildInstallContentMeta(
    const CnmtInfo& cnmt,
    const uint8_t metaNcaId[16],
    uint64_t metaNcaSize);

} // namespace nslib
