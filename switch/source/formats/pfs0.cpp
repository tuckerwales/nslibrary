#include "formats/pfs0.hpp"

#include "formats/crypto.hpp"

#include <algorithm>
#include <cstring>

namespace nslib {
namespace {

constexpr uint32_t kPfs0EntrySize = 0x18;
constexpr uint32_t kHfs0EntrySize = 0x40;
constexpr uint32_t kMaxEntries = 0x4000;
constexpr uint32_t kMaxStringTable = 0x100000;

std::string toLower(std::string s) {
    for (char& c : s) {
        if (c >= 'A' && c <= 'Z') c = char(c - 'A' + 'a');
    }
    return s;
}

bool endsWith(const std::string& s, const char* suffix) {
    const size_t n = std::strlen(suffix);
    return s.size() >= n && s.compare(s.size() - n, n, suffix) == 0;
}

} // namespace

EntryKind classifyEntry(const std::string& name) {
    const std::string lower = toLower(name);
    if (endsWith(lower, ".cnmt.nca") || endsWith(lower, ".cnmt.ncz")) return EntryKind::Cnmt;
    if (endsWith(lower, ".nca")) return EntryKind::Nca;
    if (endsWith(lower, ".ncz")) return EntryKind::Ncz;
    if (endsWith(lower, ".tik")) return EntryKind::Tik;
    if (endsWith(lower, ".cert")) return EntryKind::Cert;
    return EntryKind::Other;
}

const char* entryKindName(EntryKind kind) {
    switch (kind) {
        case EntryKind::Cnmt: return "cnmt";
        case EntryKind::Nca: return "nca";
        case EntryKind::Ncz: return "ncz";
        case EntryKind::Tik: return "tik";
        case EntryKind::Cert: return "cert";
        case EntryKind::Other: return "other";
    }
    return "other";
}

Partition parsePfs0(const Reader& reader, uint64_t base, uint64_t end) {
    if (end == UINT64_MAX) end = reader.size();
    if (!rangeFits(base, 0x10, end)) {
        throw FormatError("TRUNCATED", "PFS0 header at " + hexOffset(base) + " extends past " + hexOffset(end));
    }

    auto fixed = reader.readExact(base, 0x10);
    if (std::memcmp(fixed.data(), "PFS0", 4) != 0) {
        const std::string magic(reinterpret_cast<char*>(fixed.data()), 4);
        throw FormatError("BAD_MAGIC", "expected PFS0 at " + hexOffset(base) + ", found \"" + magic + "\"");
    }

    const uint32_t count = readU32(fixed.data() + 4);
    const uint32_t stringTableSize = readU32(fixed.data() + 8);
    if (count > kMaxEntries) {
        throw FormatError("INVALID", "PFS0 at " + hexOffset(base) + " claims " + std::to_string(count) + " entries");
    }
    if (stringTableSize > kMaxStringTable) {
        throw FormatError("INVALID", "PFS0 at " + hexOffset(base) + " has a " + std::to_string(stringTableSize) +
            "-byte string table");
    }

    const uint64_t stringTableOffset = 0x10 + uint64_t(count) * kPfs0EntrySize;
    const uint64_t headerSize = stringTableOffset + stringTableSize;
    if (!rangeFits(base, headerSize, end)) {
        throw FormatError("TRUNCATED", "PFS0 header at " + hexOffset(base) + " extends past " + hexOffset(end));
    }

    auto header = reader.readExact(base, size_t(headerSize));
    const uint64_t dataStart = base + headerSize;

    Partition out;
    out.offset = base;
    out.headerSize = headerSize;
    out.entries.reserve(count);

    for (uint32_t i = 0; i < count; i++) {
        const uint8_t* e = header.data() + 0x10 + i * kPfs0EntrySize;
        const uint32_t nameOffset = readU32(e + 0x10);
        const uint64_t start = stringTableOffset + nameOffset;
        if (start >= headerSize) {
            throw FormatError("INVALID", "entry " + std::to_string(i) + " name offset " + hexOffset(nameOffset) +
                " is outside the string table");
        }
        const uint8_t* ns = header.data() + start;
        const uint8_t* ne = header.data() + headerSize;
        const uint8_t* nul = std::find(ns, ne, 0);
        std::string name(reinterpret_cast<const char*>(ns), reinterpret_cast<const char*>(nul));

        PartitionEntry entry;
        entry.name = std::move(name);
        const uint64_t relative = readU64(e);
        entry.size = readU64(e + 8);
        entry.kind = classifyEntry(entry.name);
        if (!rangeFits(dataStart, relative, end) || !rangeFits(dataStart + relative, entry.size, end)) {
            throw FormatError("TRUNCATED", "entry \"" + entry.name + "\" at " + hexOffset(relative) + "+" +
                hexOffset(entry.size) + " extends past " + hexOffset(end));
        }
        entry.offset = dataStart + relative;
        out.entries.push_back(std::move(entry));
    }
    return out;
}

Hfs0Partition parseHfs0(const Reader& reader, uint64_t base, uint64_t end) {
    if (end == UINT64_MAX) end = reader.size();
    if (!rangeFits(base, 0x10, end)) {
        throw FormatError("TRUNCATED", "HFS0 header at " + hexOffset(base) + " extends past " + hexOffset(end));
    }

    auto fixed = reader.readExact(base, 0x10);
    if (std::memcmp(fixed.data(), "HFS0", 4) != 0) {
        const std::string magic(reinterpret_cast<char*>(fixed.data()), 4);
        throw FormatError("BAD_MAGIC", "expected HFS0 at " + hexOffset(base) + ", found \"" + magic + "\"");
    }

    const uint32_t count = readU32(fixed.data() + 4);
    const uint32_t stringTableSize = readU32(fixed.data() + 8);
    if (count > kMaxEntries) {
        throw FormatError("INVALID", "HFS0 at " + hexOffset(base) + " claims " + std::to_string(count) + " entries");
    }
    if (stringTableSize > kMaxStringTable) {
        throw FormatError("INVALID", "HFS0 at " + hexOffset(base) + " has a " + std::to_string(stringTableSize) +
            "-byte string table");
    }

    const uint64_t stringTableOffset = 0x10 + uint64_t(count) * kHfs0EntrySize;
    const uint64_t headerSize = stringTableOffset + stringTableSize;
    if (!rangeFits(base, headerSize, end)) {
        throw FormatError("TRUNCATED", "HFS0 header at " + hexOffset(base) + " extends past " + hexOffset(end));
    }

    auto header = reader.readExact(base, size_t(headerSize));
    const uint64_t dataStart = base + headerSize;

    Hfs0Partition out;
    out.offset = base;
    out.headerSize = headerSize;
    out.entries.reserve(count);

    for (uint32_t i = 0; i < count; i++) {
        const uint8_t* e = header.data() + 0x10 + i * kHfs0EntrySize;
        const uint32_t nameOffset = readU32(e + 0x10);
        const uint64_t start = stringTableOffset + nameOffset;
        if (start >= headerSize) {
            throw FormatError("INVALID", "entry " + std::to_string(i) + " name offset " + hexOffset(nameOffset) +
                " is outside the string table");
        }
        const uint8_t* ns = header.data() + start;
        const uint8_t* ne = header.data() + headerSize;
        const uint8_t* nul = std::find(ns, ne, 0);
        std::string name(reinterpret_cast<const char*>(ns), reinterpret_cast<const char*>(nul));

        Hfs0Entry entry;
        entry.name = std::move(name);
        const uint64_t relative = readU64(e);
        entry.size = readU64(e + 8);
        entry.kind = classifyEntry(entry.name);
        entry.hashedSize = readU32(e + 0x14);
        std::memcpy(entry.sha256, e + 0x20, 32);
        if (!rangeFits(dataStart, relative, end) || !rangeFits(dataStart + relative, entry.size, end)) {
            throw FormatError("TRUNCATED", "entry \"" + entry.name + "\" at " + hexOffset(relative) + "+" +
                hexOffset(entry.size) + " extends past " + hexOffset(end));
        }
        entry.offset = dataStart + relative;
        out.entries.push_back(std::move(entry));
    }
    return out;
}

Partition toPartition(const Hfs0Partition& h) {
    Partition p;
    p.offset = h.offset;
    p.headerSize = h.headerSize;
    p.entries.reserve(h.entries.size());
    for (const auto& e : h.entries) {
        PartitionEntry pe;
        pe.name = e.name;
        pe.offset = e.offset;
        pe.size = e.size;
        pe.kind = e.kind;
        p.entries.push_back(std::move(pe));
    }
    return p;
}

std::vector<uint8_t> buildPfs0(const std::vector<NamedBytes>& files, uint32_t align) {
    const uint32_t fixedSize = 0x10 + uint32_t(files.size()) * kPfs0EntrySize;
    std::vector<uint32_t> offsets;
    std::string table;
    offsets.reserve(files.size());
    for (const auto& file : files) {
        offsets.push_back(uint32_t(table.size()));
        table.append(file.name);
        table.push_back('\0');
    }
    const uint32_t padding = align ? (align - ((fixedSize + uint32_t(table.size())) % align)) % align : 0;
    table.append(padding, '\0');

    std::vector<uint8_t> out(fixedSize + table.size());
    std::memcpy(out.data(), "PFS0", 4);
    writeU32(out.data() + 4, uint32_t(files.size()));
    writeU32(out.data() + 8, uint32_t(table.size()));
    uint64_t dataOffset = 0;
    for (size_t i = 0; i < files.size(); i++) {
        uint8_t* e = out.data() + 0x10 + i * kPfs0EntrySize;
        writeU64(e, dataOffset);
        writeU64(e + 8, files[i].data.size());
        writeU32(e + 0x10, offsets[i]);
        dataOffset += files[i].data.size();
    }
    std::memcpy(out.data() + fixedSize, table.data(), table.size());
    for (const auto& file : files) {
        out.insert(out.end(), file.data.begin(), file.data.end());
    }
    return out;
}

std::vector<uint8_t> buildHfs0(const std::vector<NamedBytes>& files, uint32_t align, uint32_t hashedSize) {
    const uint32_t fixedSize = 0x10 + uint32_t(files.size()) * kHfs0EntrySize;
    std::vector<uint32_t> offsets;
    std::string table;
    offsets.reserve(files.size());
    for (const auto& file : files) {
        offsets.push_back(uint32_t(table.size()));
        table.append(file.name);
        table.push_back('\0');
    }
    const uint32_t padding = align ? (align - ((fixedSize + uint32_t(table.size())) % align)) % align : 0;
    table.append(padding, '\0');

    std::vector<uint8_t> out(fixedSize + table.size());
    std::memcpy(out.data(), "HFS0", 4);
    writeU32(out.data() + 4, uint32_t(files.size()));
    writeU32(out.data() + 8, uint32_t(table.size()));
    uint64_t dataOffset = 0;
    for (size_t i = 0; i < files.size(); i++) {
        uint8_t* e = out.data() + 0x10 + i * kHfs0EntrySize;
        writeU64(e, dataOffset);
        writeU64(e + 8, files[i].data.size());
        writeU32(e + 0x10, offsets[i]);
        const uint32_t covered = std::min(hashedSize, uint32_t(files[i].data.size()));
        writeU32(e + 0x14, covered);
        if (covered) {
            const auto hash = sha256(files[i].data.data(), covered);
            std::memcpy(e + 0x20, hash.data(), 32);
        }
        dataOffset += files[i].data.size();
    }
    std::memcpy(out.data() + fixedSize, table.data(), table.size());
    for (const auto& file : files) {
        out.insert(out.end(), file.data.begin(), file.data.end());
    }
    return out;
}

} // namespace nslib
