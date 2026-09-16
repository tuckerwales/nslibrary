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

} // namespace nslib
