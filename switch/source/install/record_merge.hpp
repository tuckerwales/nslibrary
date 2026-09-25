#pragma once

#include <cstdint>
#include <vector>

namespace nslib {

constexpr uint8_t kMetaTypeApplication = 0x80;
constexpr uint8_t kMetaTypePatch = 0x81;
constexpr uint8_t kMetaTypeAddOnContent = 0x82;

/** One ns application content-meta record, without the libnx types so host tests can use it. */
struct MetaRecord {
    uint64_t id = 0;
    uint32_t version = 0;
    uint8_t type = 0;
    uint8_t storage = 0;
};

/** Replace any record for the same title ID (older patch, reinstalled DLC) and append `incoming`.
 *  Records for other title IDs, such as sibling DLC, are kept. */
std::vector<MetaRecord> mergeMetaRecord(std::vector<MetaRecord> records, const MetaRecord& incoming);

/** Drop the record for `id` on `storage`, as when that update or DLC is uninstalled. */
std::vector<MetaRecord> removeMetaRecord(std::vector<MetaRecord> records, uint64_t id, uint8_t storage);

/** Point the record for `id` on `from` at `to`, as when its content moves between SD and NAND. */
std::vector<MetaRecord> moveMetaRecord(std::vector<MetaRecord> records, uint64_t id, uint8_t from, uint8_t to);

/** Highest application or patch version. Add-on versions do not count toward the launch version. */
uint32_t launchVersionFor(const std::vector<MetaRecord>& records);

} // namespace nslib
