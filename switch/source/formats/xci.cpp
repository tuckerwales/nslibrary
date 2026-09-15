#include "formats/xci.hpp"

#include <cstring>
#include <set>

namespace nslib {
namespace {

constexpr uint64_t kCardHeaderMagicOffset = 0x100;
constexpr uint64_t kRootPartitionOffsetField = 0x130;
constexpr uint64_t kCardHeaderSize = 0x140;
constexpr uint64_t kKeyAreaSize = 0x1000;

const std::set<std::string> kKnownPartitions = {"update", "normal", "secure", "logo"};

uint64_t findCardHeader(const Reader& reader) {
    for (uint64_t candidate : {uint64_t(0), kKeyAreaSize}) {
        if (candidate + kCardHeaderSize > reader.size()) continue;
        auto magic = reader.readExact(candidate + kCardHeaderMagicOffset, 4);
        if (std::memcmp(magic.data(), "HEAD", 4) == 0) return candidate;
    }
    throw FormatError("BAD_MAGIC", "no XCI card header (HEAD) at 0x100 or 0x1100");
}

} // namespace

XciInfo parseXci(const Reader& reader) {
    XciInfo info;
    info.cardOffset = findCardHeader(reader);
    auto header = reader.readExact(info.cardOffset, size_t(kCardHeaderSize));
    const uint64_t rootRelative = readU64(header.data() + kRootPartitionOffsetField);
    if (!rangeFits(info.cardOffset, rootRelative, reader.size())) {
        throw FormatError("TRUNCATED", "XCI root partition offset " + hexOffset(rootRelative) + " is past the end");
    }
    info.root = parseHfs0(reader, info.cardOffset + rootRelative);

    for (const auto& entry : info.root.entries) {
        if (!kKnownPartitions.count(entry.name)) continue;
        if (entry.size == 0) continue;
        info.partitions.emplace(entry.name, parseHfs0(reader, entry.offset, entry.offset + entry.size));
    }

    auto it = info.partitions.find("secure");
    if (it == info.partitions.end()) throw FormatError("INVALID", "XCI has no secure partition");
    info.secure = it->second;
    return info;
}

} // namespace nslib
