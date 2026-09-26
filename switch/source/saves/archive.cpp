#include "saves/archive.hpp"

#include "formats/crypto.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <map>
#include <set>
#include <stdexcept>

namespace nslib {
namespace {

constexpr uint64_t kMaxEntrySize = 077777777777ull;
constexpr size_t kCopyChunk = 256 * 1024;

std::vector<std::string> splitPath(const std::string& path) {
    std::vector<std::string> parts;
    size_t start = 0;
    for (;;) {
        const size_t slash = path.find('/', start);
        parts.push_back(path.substr(start, slash == std::string::npos ? std::string::npos : slash - start));
        if (slash == std::string::npos) break;
        start = slash + 1;
    }
    return parts;
}

void writeOctal(uint8_t* field, size_t width, uint64_t value) {
    // width - 1 digits, then NUL.
    char digits[32];
    std::snprintf(digits, sizeof(digits), "%0*llo", int(width - 1), static_cast<unsigned long long>(value));
    std::memcpy(field, digits, width - 1);
    field[width - 1] = 0;
}

std::string cString(const uint8_t* field, size_t length) {
    size_t n = 0;
    while (n < length && field[n]) n++;
    return std::string(reinterpret_cast<const char*>(field), n);
}

uint64_t parseOctal(const uint8_t* field, size_t length, const char* what) {
    size_t end = length;
    while (end > 0 && (field[end - 1] == 0 || field[end - 1] == ' ')) end--;
    size_t start = 0;
    while (start < end && field[start] == ' ') start++;
    uint64_t value = 0;
    for (size_t i = start; i < end; i++) {
        if (field[i] < '0' || field[i] > '7') {
            throw FormatError("INVALID", std::string("tar ") + what + " field is not octal");
        }
        if (value > (UINT64_MAX >> 3)) throw FormatError("INVALID", std::string("tar ") + what + " field is too large");
        value = (value << 3) | uint64_t(field[i] - '0');
    }
    return value;
}

bool isZero(const uint8_t* data, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (data[i]) return false;
    }
    return true;
}

struct TreeItem {
    std::string tarPath;
    std::string path;
    bool dir = false;
    uint64_t size = 0;
};

void walk(SaveTreeReader& tree, const std::string& dir, std::vector<TreeItem>& out) {
    for (const auto& entry : tree.list(dir)) {
        const std::string path = dir.empty() ? entry.name : dir + "/" + entry.name;
        const std::string problem = saveArchivePathProblem(path);
        if (!problem.empty()) throw FormatError("INVALID", problem + ": " + path);
        if (out.size() >= kSaveArchiveMaxEntries) throw FormatError("UNSUPPORTED", "the save has too many files");
        if (entry.dir) {
            out.push_back({path + "/", path, true, 0});
            walk(tree, path, out);
        } else {
            if (entry.size > kMaxEntrySize) throw FormatError("UNSUPPORTED", "file is too large for ustar: " + path);
            out.push_back({path, path, false, entry.size});
        }
    }
}

} // namespace

std::string saveArchivePathProblem(const std::string& path) {
    if (path.empty()) return "empty path";
    if (path.size() > kSaveArchiveMaxPath - 1) {
        return "path is longer than " + std::to_string(kSaveArchiveMaxPath - 1) + " bytes";
    }
    if (path.find('\0') != std::string::npos) return "path contains a NUL byte";
    if (path.find('\\') != std::string::npos) return "path contains a backslash";
    if (path[0] == '/') return "path is absolute";
    for (const auto& part : splitPath(path)) {
        if (part.empty()) return "path has an empty component";
        if (part == "." || part == "..") return "path contains \"" + part + "\"";
    }
    return {};
}

bool splitUstarPath(const std::string& tarPath, std::string& prefix, std::string& name) {
    if (tarPath.size() <= 100) {
        prefix.clear();
        name = tarPath;
        return true;
    }
    for (size_t i = std::min<size_t>(155, tarPath.size() - 1) + 1; i-- > 0;) {
        if (tarPath[i] != '/') continue;
        const size_t nameLength = tarPath.size() - i - 1;
        if (nameLength >= 1 && nameLength <= 100) {
            prefix = tarPath.substr(0, i);
            name = tarPath.substr(i + 1);
            return true;
        }
    }
    return false;
}

std::array<uint8_t, kTarBlock> ustarHeader(const std::string& tarPath, bool dir, uint64_t size) {
    std::string prefix, name;
    if (!splitUstarPath(tarPath, prefix, name)) {
        throw FormatError("UNSUPPORTED", "path does not fit a ustar header: " + tarPath);
    }
    if (size > kMaxEntrySize) throw FormatError("UNSUPPORTED", "file is too large for ustar: " + tarPath);
    std::array<uint8_t, kTarBlock> h{};
    std::memcpy(h.data(), name.data(), name.size());
    writeOctal(h.data() + 100, 8, dir ? 0755 : 0644);
    writeOctal(h.data() + 108, 8, 0);
    writeOctal(h.data() + 116, 8, 0);
    writeOctal(h.data() + 124, 12, size);
    writeOctal(h.data() + 136, 12, 0);
    std::memset(h.data() + 148, ' ', 8);
    h[156] = dir ? '5' : '0';
    std::memcpy(h.data() + 257, "ustar\0", 6);
    std::memcpy(h.data() + 263, "00", 2);
    std::memcpy(h.data() + 345, prefix.data(), prefix.size());
    uint32_t sum = 0;
    for (uint8_t b : h) sum += b;
    char digits[8];
    std::snprintf(digits, sizeof(digits), "%06o", sum);
    std::memcpy(h.data() + 148, digits, 6);
    h[154] = 0;
    h[155] = ' ';
    return h;
}

SaveArchiveInfo writeSaveArchive(SaveTreeReader& tree, const SaveSink& out, const SaveProgressFn& progress) {
    std::vector<TreeItem> items;
    walk(tree, "", items);
    // std::string compares as unsigned bytes, the same order as Buffer.compare on the server.
    std::sort(items.begin(), items.end(), [](const TreeItem& a, const TreeItem& b) { return a.tarPath < b.tarPath; });

    uint64_t total = 0;
    for (const auto& item : items) total += item.size;

    SaveArchiveInfo info;
    Sha256 hash;
    const auto emit = [&](const uint8_t* p, size_t n) {
        if (!n) return;
        hash.update(p, n);
        out(p, n);
        info.bytes += n;
    };
    static const uint8_t zeros[kTarBlock] = {};
    uint64_t done = 0;
    if (progress) progress(0, total);
    for (const auto& item : items) {
        const auto header = ustarHeader(item.tarPath, item.dir, item.size);
        emit(header.data(), header.size());
        if (item.dir) continue;
        uint64_t got = 0;
        tree.read(item.path, item.size, [&](const uint8_t* p, size_t n) {
            if (got + n > item.size) throw std::runtime_error("The save changed while it was backed up: " + item.path);
            emit(p, n);
            got += n;
            done += n;
            if (progress) progress(done, total);
        });
        if (got != item.size) throw std::runtime_error("The save changed while it was backed up: " + item.path);
        const size_t pad = size_t((kTarBlock - item.size % kTarBlock) % kTarBlock);
        emit(zeros, pad);
        info.files++;
        info.dataSize += item.size;
    }
    emit(zeros, kTarBlock);
    emit(zeros, kTarBlock);
    hash.final(info.sha256.data());
    return info;
}

SaveArchiveListing listSaveArchive(const Reader& archive) {
    const uint64_t size = archive.size();
    if (size % kTarBlock != 0) throw FormatError("INVALID", "archive size is not a multiple of 512 bytes");
    SaveArchiveListing listing;
    std::set<std::string> seen;
    uint64_t offset = 0;
    uint8_t h[kTarBlock];
    for (;;) {
        if (offset + kTarBlock > size) throw FormatError("TRUNCATED", "archive ends without the two zero blocks");
        archive.read(offset, h, kTarBlock);
        if (isZero(h, kTarBlock)) {
            if (offset + 2 * kTarBlock > size) throw FormatError("TRUNCATED", "archive ends after a single zero block");
            // Tools pad archives to a record size with more zero blocks; anything else is not a tar.
            std::vector<uint8_t> rest(64 * kTarBlock);
            for (uint64_t at = offset + kTarBlock; at < size;) {
                const size_t n = size_t(std::min<uint64_t>(rest.size(), size - at));
                archive.read(at, rest.data(), n);
                if (!isZero(rest.data(), n)) throw FormatError("INVALID", "data after the end of archive");
                at += n;
            }
            break;
        }

        if (std::memcmp(h + 257, "ustar", 5) != 0) throw FormatError("BAD_MAGIC", "not a ustar archive");
        const uint64_t stored = parseOctal(h + 148, 8, "checksum");
        uint64_t sum = 0;
        for (size_t i = 0; i < kTarBlock; i++) sum += (i >= 148 && i < 156) ? uint64_t(' ') : uint64_t(h[i]);
        if (sum != stored) throw FormatError("INVALID", "bad header checksum at " + std::to_string(offset));

        const char typeflag = char(h[156]);
        const std::string name = cString(h, 100);
        const std::string prefix = cString(h + 345, 155);
        std::string path = prefix.empty() ? name : prefix + "/" + name;
        bool dir = false;
        if (typeflag == '5') {
            dir = true;
            while (!path.empty() && path.back() == '/') path.pop_back();
        } else if (typeflag != '0' && typeflag != '\0') {
            throw FormatError("UNSUPPORTED", std::string("unsupported tar entry type '") + typeflag + "'");
        }
        // `tar -cf save.tar .` names everything ./…, and adds the folder itself as "./".
        while (path.rfind("./", 0) == 0) path.erase(0, 2);
        if (dir && (path.empty() || path == ".")) {
            offset += kTarBlock;
            continue;
        }
        const std::string problem = saveArchivePathProblem(path);
        if (!problem.empty()) throw FormatError("INVALID", problem + ": " + path);
        if (!seen.insert(path).second) throw FormatError("INVALID", "duplicate entry: " + path);

        const uint64_t entrySize = dir ? 0 : parseOctal(h + 124, 12, "size");
        const uint64_t dataOffset = offset + kTarBlock;
        const uint64_t padded = (entrySize + kTarBlock - 1) / kTarBlock * kTarBlock;
        if (padded > size - dataOffset) throw FormatError("TRUNCATED", "entry runs past the end of the archive: " + path);
        listing.entries.push_back({path, dir, entrySize, dataOffset});
        if (listing.entries.size() > kSaveArchiveMaxEntries) throw FormatError("UNSUPPORTED", "archive has too many entries");
        if (!dir) {
            listing.files++;
            listing.dataSize += entrySize;
        }
        offset = dataOffset + padded;
    }

    // A file and a directory of the same name, or a file used as a directory, cannot be restored.
    std::map<std::string, bool> isDir;
    for (const auto& e : listing.entries) isDir[e.path] = e.dir;
    for (const auto& e : listing.entries) {
        for (size_t slash = e.path.find('/'); slash != std::string::npos; slash = e.path.find('/', slash + 1)) {
            const auto it = isDir.find(e.path.substr(0, slash));
            if (it != isDir.end() && !it->second) throw FormatError("INVALID", e.path + " is inside a file");
        }
    }
    return listing;
}

void restoreSaveArchive(const Reader& archive, SaveTreeWriter& save, uint64_t journalBytes, const SaveProgressFn& progress) {
    const SaveArchiveListing listing = listSaveArchive(archive);
    const uint64_t total = listing.dataSize;
    uint64_t done = 0;

    // Checked before the save is touched, so a cancel here leaves it as it was.
    if (progress) progress(0, total);
    save.clear();

    std::set<std::string> made;
    const auto ensureDir = [&](const std::string& path) {
        // Archives from other tools can leave out directory entries; create parents as needed.
        for (size_t slash = path.find('/'); ; slash = path.find('/', slash + 1)) {
            const std::string part = slash == std::string::npos ? path : path.substr(0, slash);
            if (made.insert(part).second) save.makeDir(part);
            if (slash == std::string::npos) break;
        }
    };
    const auto parentOf = [](const std::string& path) {
        const size_t slash = path.rfind('/');
        return slash == std::string::npos ? std::string() : path.substr(0, slash);
    };

    const uint64_t budget = journalBytes ? std::max<uint64_t>(journalBytes / 4 * 3, 1) : 0;
    const size_t chunkSize = budget ? size_t(std::min<uint64_t>(kCopyChunk, budget)) : kCopyChunk;
    std::vector<uint8_t> chunk(chunkSize);
    uint64_t pending = 0;
    for (const auto& e : listing.entries) {
        if (e.dir) {
            ensureDir(e.path);
            continue;
        }
        const std::string parent = parentOf(e.path);
        if (!parent.empty()) ensureDir(parent);
        save.beginFile(e.path, e.size);
        for (uint64_t at = 0; at < e.size;) {
            const size_t n = size_t(std::min<uint64_t>(chunk.size(), e.size - at));
            archive.read(e.offset + at, chunk.data(), n);
            if (budget && pending > 0 && pending + n > budget) {
                save.commit();
                pending = 0;
            }
            save.write(chunk.data(), n);
            pending += n;
            at += n;
            done += n;
            if (progress) progress(done, total);
        }
        save.endFile();
        if (!budget) save.commit();
    }
    save.commit();
}

std::string accountIdHex(uint64_t uid0, uint64_t uid1) {
    char buf[33];
    std::snprintf(buf, sizeof(buf), "%016llX%016llX", static_cast<unsigned long long>(uid0),
        static_cast<unsigned long long>(uid1));
    return buf;
}

std::string sha256Hex(const std::array<uint8_t, 32>& digest) {
    static const char* hex = "0123456789abcdef";
    std::string out;
    out.reserve(64);
    for (uint8_t b : digest) {
        out.push_back(hex[b >> 4]);
        out.push_back(hex[b & 15]);
    }
    return out;
}

} // namespace nslib
