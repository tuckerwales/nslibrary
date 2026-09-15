#include "formats/cnmt.hpp"

#include <cstring>

namespace nslib {

const char* packagedKindName(PackagedKind kind) {
    switch (kind) {
        case PackagedKind::Application: return "application";
        case PackagedKind::Patch: return "patch";
        case PackagedKind::Addon: return "addon";
        case PackagedKind::Other: return "other";
    }
    return "other";
}

static PackagedKind kindOf(uint8_t rawType) {
    switch (rawType) {
        case uint8_t(CnmtType::Application): return PackagedKind::Application;
        case uint8_t(CnmtType::Patch): return PackagedKind::Patch;
        case uint8_t(CnmtType::AddOnContent): return PackagedKind::Addon;
        default: return PackagedKind::Other;
    }
}

CnmtInfo parseCnmt(const uint8_t* data, size_t size) {
    if (size < kCnmtHeaderSize) {
        throw FormatError("TRUNCATED", "CNMT is " + hexOffset(size) + " bytes, expected a 0x20 header");
    }

    CnmtInfo info;
    info.raw.assign(data, data + size);
    info.titleIdValue = readU64(data);
    info.titleId = titleIdString(info.titleIdValue);
    info.version = readU32(data + 8);
    info.rawType = data[0xc];
    info.extendedHeaderSize = readU16(data + 0xe);
    info.contentCount = readU16(data + 0x10);
    info.contentMetaCount = readU16(data + 0x12);
    info.attributes = data[0x14];
    info.kind = kindOf(info.rawType);

    info.tableOffset = kCnmtHeaderSize + info.extendedHeaderSize;
    const size_t recordsEnd = info.tableOffset + size_t(info.contentCount) * kCnmtContentRecordSize;
    if (size < recordsEnd) {
        throw FormatError("TRUNCATED", "CNMT needs " + hexOffset(recordsEnd) + " bytes for " +
            std::to_string(info.contentCount) + " records, has " + hexOffset(size));
    }

    info.extendedHeader.assign(data + kCnmtHeaderSize, data + info.tableOffset);
    info.applicationIdValue = info.titleIdValue;
    info.applicationId = info.titleId;

    if (info.kind == PackagedKind::Application && info.extendedHeader.size() >= 0x0c) {
        info.requiredSystemVersion = readU32(info.extendedHeader.data() + 8);
        info.hasRequiredSystemVersion = true;
    } else if (info.kind == PackagedKind::Patch && info.extendedHeader.size() >= 0x0c) {
        info.applicationIdValue = readU64(info.extendedHeader.data());
        info.applicationId = titleIdString(info.applicationIdValue);
        info.requiredSystemVersion = readU32(info.extendedHeader.data() + 8);
        info.hasRequiredSystemVersion = true;
    } else if (info.kind == PackagedKind::Addon && info.extendedHeader.size() >= 0x08) {
        info.applicationIdValue = readU64(info.extendedHeader.data());
        info.applicationId = titleIdString(info.applicationIdValue);
        if (info.extendedHeader.size() >= 0x0c) {
            info.requiredApplicationVersion = readU32(info.extendedHeader.data() + 8);
            info.hasRequiredApplicationVersion = true;
        }
    }

    info.contents.reserve(info.contentCount);
    for (uint16_t i = 0; i < info.contentCount; i++) {
        const uint8_t* rec = data + info.tableOffset + i * kCnmtContentRecordSize;
        CnmtContentRecord c;
        c.sha256 = hexLower(rec, 0x20);
        std::memcpy(c.ncaIdBytes, rec + 0x20, 16);
        c.ncaId = hexLower(c.ncaIdBytes, 16);
        c.size = readU40(rec + 0x30);
        c.attr = rec[0x35];
        c.type = rec[0x36];
        c.idOffset = rec[0x37];
        info.installSize += c.size;
        info.contents.push_back(std::move(c));
    }

    if (size >= recordsEnd + kCnmtDigestSize) {
        info.digest.assign(data + recordsEnd, data + recordsEnd + kCnmtDigestSize);
        info.hasDigest = true;
    }
    return info;
}

} // namespace nslib
