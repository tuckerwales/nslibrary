#include "install/record_merge.hpp"

#include <algorithm>

namespace nslib {

std::vector<MetaRecord> mergeMetaRecord(std::vector<MetaRecord> records, const MetaRecord& incoming) {
    records.erase(std::remove_if(records.begin(), records.end(),
                      [&](const MetaRecord& r) { return r.id == incoming.id; }),
        records.end());
    records.push_back(incoming);
    return records;
}

uint32_t launchVersionFor(const std::vector<MetaRecord>& records) {
    uint32_t version = 0;
    for (const auto& r : records) {
        if (r.type != kMetaTypeApplication && r.type != kMetaTypePatch) continue;
        version = std::max(version, r.version);
    }
    return version;
}

} // namespace nslib
