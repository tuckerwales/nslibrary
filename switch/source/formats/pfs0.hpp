#pragma once

#include "formats/bytes.hpp"

#include <string>
#include <vector>

namespace nslib {

enum class EntryKind { Cnmt, Nca, Ncz, Tik, Cert, Other };

struct PartitionEntry {
    std::string name;
    uint64_t offset = 0;
    uint64_t size = 0;
    EntryKind kind = EntryKind::Other;
};

struct Partition {
    uint64_t offset = 0;
    uint64_t headerSize = 0;
    std::vector<PartitionEntry> entries;
};

EntryKind classifyEntry(const std::string& name);
const char* entryKindName(EntryKind kind);

/** Parse a PFS0 (NSP/NSZ) header and entry table. Offsets are absolute in `reader`. */
Partition parsePfs0(const Reader& reader, uint64_t base = 0, uint64_t end = UINT64_MAX);

struct NamedBytes {
    std::string name;
    std::vector<uint8_t> data;
};

/** Host/test helper matching the TypeScript fixture builder (0x20 string-table align). */
std::vector<uint8_t> buildPfs0(const std::vector<NamedBytes>& files, uint32_t align = 0x20);

} // namespace nslib
