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

struct Hfs0Entry : PartitionEntry {
    uint32_t hashedSize = 0;
    uint8_t sha256[32]{};
};

struct Hfs0Partition {
    uint64_t offset = 0;
    uint64_t headerSize = 0;
    std::vector<Hfs0Entry> entries;
};

EntryKind classifyEntry(const std::string& name);
const char* entryKindName(EntryKind kind);

/** Parse a PFS0 (NSP/NSZ) header and entry table. Offsets are absolute in `reader`. */
Partition parsePfs0(const Reader& reader, uint64_t base = 0, uint64_t end = UINT64_MAX);

/** Parse an HFS0 (XCI partition) header. Offsets are absolute in `reader`. */
Hfs0Partition parseHfs0(const Reader& reader, uint64_t base = 0, uint64_t end = UINT64_MAX);

Partition toPartition(const Hfs0Partition& h);

struct NamedBytes {
    std::string name;
    std::vector<uint8_t> data;
};

/** Host/test helper matching the TypeScript fixture builder (0x20 string-table align). */
std::vector<uint8_t> buildPfs0(const std::vector<NamedBytes>& files, uint32_t align = 0x20);
std::vector<uint8_t> buildHfs0(const std::vector<NamedBytes>& files, uint32_t align = 0x20, uint32_t hashedSize = 0x200);

} // namespace nslib
