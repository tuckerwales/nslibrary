#include "formats/meta.hpp"

#include <cstring>

namespace nslib {

std::vector<uint8_t> buildInstallContentMeta(
    const CnmtInfo& cnmt,
    const uint8_t metaNcaId[16],
    uint64_t metaNcaSize)
{
    std::vector<ContentInfo> infos;
    infos.reserve(cnmt.contents.size() + 1);
    for (const auto& rec : cnmt.contents) {
        if (rec.type == uint8_t(CnmtContentType::DeltaFragment)) continue;
        ContentInfo info{};
        std::memcpy(info.contentId, rec.ncaIdBytes, 16);
        contentInfoSetSize(info, rec.size);
        info.attr = rec.attr;
        info.contentType = rec.type;
        info.idOffset = rec.idOffset;
        infos.push_back(info);
    }

    ContentInfo meta{};
    std::memcpy(meta.contentId, metaNcaId, 16);
    contentInfoSetSize(meta, metaNcaSize);
    meta.contentType = uint8_t(CnmtContentType::Meta);
    infos.push_back(meta);

    ContentMetaHeader header{};
    header.extendedHeaderSize = cnmt.extendedHeaderSize;
    header.contentCount = uint16_t(infos.size());
    header.contentMetaCount = cnmt.contentMetaCount;
    header.attributes = cnmt.attributes;
    header.storageId = 0;

    std::vector<uint8_t> out(sizeof(header) + cnmt.extendedHeader.size() + infos.size() * sizeof(ContentInfo));
    std::memcpy(out.data(), &header, sizeof(header));
    if (!cnmt.extendedHeader.empty()) {
        std::memcpy(out.data() + sizeof(header), cnmt.extendedHeader.data(), cnmt.extendedHeader.size());
    }
    uint8_t* dest = out.data() + sizeof(header) + cnmt.extendedHeader.size();
    for (const auto& info : infos) {
        std::memcpy(dest, &info, sizeof(info));
        dest += sizeof(info);
    }
    if (cnmt.hasDigest) {
        out.insert(out.end(), cnmt.digest.begin(), cnmt.digest.end());
    }
    return out;
}

namespace {

/** Offset of RequiredSystemVersion in the blob, or 0 when this meta has none. */
size_t requiredSystemVersionOffset(uint8_t metaType, const std::vector<uint8_t>& blob) {
    if (metaType != uint8_t(CnmtType::Application) && metaType != uint8_t(CnmtType::Patch)) return 0;
    if (blob.size() < sizeof(ContentMetaHeader)) return 0;
    ContentMetaHeader header{};
    std::memcpy(&header, blob.data(), sizeof(header));
    // Both extended headers start with an 8-byte title id, then the u32 we want.
    const size_t offset = sizeof(header) + 8;
    if (header.extendedHeaderSize < 12 || blob.size() < offset + 4) return 0;
    return offset;
}

} // namespace

std::optional<uint32_t> storedRequiredSystemVersion(uint8_t metaType, const std::vector<uint8_t>& blob) {
    const size_t offset = requiredSystemVersionOffset(metaType, blob);
    if (!offset) return std::nullopt;
    uint32_t version = 0;
    std::memcpy(&version, blob.data() + offset, sizeof(version));
    return version;
}

bool clearRequiredSystemVersion(uint8_t metaType, std::vector<uint8_t>& blob) {
    const auto version = storedRequiredSystemVersion(metaType, blob);
    if (!version || *version == 0) return false;
    std::memset(blob.data() + requiredSystemVersionOffset(metaType, blob), 0, sizeof(uint32_t));
    return true;
}

std::vector<ContentInfo> storedContentInfos(const std::vector<uint8_t>& blob) {
    if (blob.size() < sizeof(ContentMetaHeader)) return {};
    ContentMetaHeader header{};
    std::memcpy(&header, blob.data(), sizeof(header));
    const size_t start = sizeof(header) + header.extendedHeaderSize;
    const size_t end = start + size_t(header.contentCount) * sizeof(ContentInfo);
    if (blob.size() < end) return {};
    std::vector<ContentInfo> out(header.contentCount);
    if (!out.empty()) std::memcpy(out.data(), blob.data() + start, out.size() * sizeof(ContentInfo));
    return out;
}

std::optional<uint64_t> storedApplicationId(uint8_t metaType, const std::vector<uint8_t>& blob) {
    // A game's extended header starts with its patch id instead.
    if (metaType != uint8_t(CnmtType::Patch) && metaType != uint8_t(CnmtType::AddOnContent)) return std::nullopt;
    if (blob.size() < sizeof(ContentMetaHeader) + 8) return std::nullopt;
    ContentMetaHeader header{};
    std::memcpy(&header, blob.data(), sizeof(header));
    if (header.extendedHeaderSize < 8) return std::nullopt;
    uint64_t id = 0;
    std::memcpy(&id, blob.data() + sizeof(header), sizeof(id));
    return id;
}

} // namespace nslib
