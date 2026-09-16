#pragma once

#include "formats/bytes.hpp"

#include <string>
#include <vector>

namespace nslib {

constexpr size_t kCnmtHeaderSize = 0x20;
constexpr size_t kCnmtContentRecordSize = 0x38;
constexpr size_t kCnmtDigestSize = 0x20;

enum class CnmtType : uint8_t {
    Application = 0x80,
    Patch = 0x81,
    AddOnContent = 0x82,
    Delta = 0x83,
};

enum class CnmtContentType : uint8_t {
    Meta = 0,
    Program = 1,
    Data = 2,
    Control = 3,
    HtmlDocument = 4,
    LegalInformation = 5,
    DeltaFragment = 6,
};

enum class PackagedKind { Application, Patch, Addon, Other };

struct CnmtContentRecord {
    std::string sha256; // lowercase hex
    std::string ncaId;  // first 16 bytes of the hash, lowercase hex
    uint8_t ncaIdBytes[16]{};
    uint64_t size = 0;
    uint8_t type = 0;
    uint8_t idOffset = 0;
    uint8_t attr = 0;
};

struct CnmtInfo {
    std::string titleId;
    uint64_t titleIdValue = 0;
    uint32_t version = 0;
    uint8_t rawType = 0;
    PackagedKind kind = PackagedKind::Other;
    std::string applicationId;
    uint64_t applicationIdValue = 0;
    uint32_t requiredSystemVersion = 0;
    bool hasRequiredSystemVersion = false;
    uint32_t requiredApplicationVersion = 0;
    bool hasRequiredApplicationVersion = false;
    uint16_t extendedHeaderSize = 0;
    uint16_t contentCount = 0;
    uint16_t contentMetaCount = 0;
    uint8_t attributes = 0;
    std::vector<uint8_t> extendedHeader;
    std::vector<CnmtContentRecord> contents;
    uint64_t installSize = 0;
    std::vector<uint8_t> digest;
    bool hasDigest = false;
    /** Offset of the content-record table in the packaged CNMT. */
    size_t tableOffset = 0;
    std::vector<uint8_t> raw;
};

const char* packagedKindName(PackagedKind kind);
CnmtInfo parseCnmt(const uint8_t* data, size_t size);
inline CnmtInfo parseCnmt(const std::vector<uint8_t>& data) { return parseCnmt(data.data(), data.size()); }

} // namespace nslib
