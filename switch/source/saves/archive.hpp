#pragma once

#include "formats/bytes.hpp"

#include <array>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace nslib {

/**
 * Save data archives: uncompressed POSIX ustar, written deterministically so an unchanged save
 * always gives the same bytes and SHA-256. The layout matches `packages/formats/src/save-archive.ts`
 * byte for byte (see docs/saves.md and packages/shared/golden/saves):
 *
 * - one entry per directory (`name/`, typeflag 5) and per file (typeflag 0);
 * - entries sorted by the byte order of their tar path, directories with their trailing slash;
 * - mode 0755/0644, uid, gid and mtime zero, no user or group names;
 * - a path over 100 bytes split at the last `/` that fits the 155-byte prefix;
 * - two zero blocks at the end.
 */
using SaveSink = std::function<void(const uint8_t*, size_t)>;

constexpr size_t kTarBlock = 512;
constexpr size_t kSaveArchiveMaxPath = 255;
constexpr size_t kSaveArchiveMaxEntries = 100000;

/** Why `path` (relative, `/`-separated, no trailing slash) cannot go in an archive; empty if it can. */
std::string saveArchivePathProblem(const std::string& path);

/** Splits a tar path into ustar prefix and name. False when it does not fit. */
bool splitUstarPath(const std::string& tarPath, std::string& prefix, std::string& name);

/** A ustar header for a file (`dir` false) or a directory (`tarPath` ending in `/`). Throws FormatError. */
std::array<uint8_t, kTarBlock> ustarHeader(const std::string& tarPath, bool dir, uint64_t size);

/** One entry of a save's file tree, as a directory listing reports it. */
struct SaveTreeEntry {
    std::string name;
    bool dir = false;
    uint64_t size = 0;
};

/** Read access to a mounted save. Paths are relative with `/` separators; "" is the root. */
class SaveTreeReader {
public:
    virtual ~SaveTreeReader() = default;
    virtual std::vector<SaveTreeEntry> list(const std::string& dir) = 0;
    /** Must deliver exactly `size` bytes; anything else means the save changed while it was read. */
    virtual void read(const std::string& path, uint64_t size, const SaveSink& sink) = 0;
};

/** Write access to a mounted save, for restoring. */
class SaveTreeWriter {
public:
    virtual ~SaveTreeWriter() = default;
    /** Removes everything in the save. */
    virtual void clear() = 0;
    virtual void makeDir(const std::string& path) = 0;
    /** Creates the file at its full size and opens it for writing from offset 0. */
    virtual void beginFile(const std::string& path, uint64_t size) = 0;
    virtual void write(const uint8_t* data, size_t n) = 0;
    virtual void endFile() = 0;
    /**
     * Commits the save's journal. May be called with a file open (a large file needs several
     * journals' worth of commits); the writer reopens it and carries on where it was.
     */
    virtual void commit() = 0;
};

struct SaveArchiveInfo {
    uint64_t bytes = 0;
    uint32_t files = 0;
    uint64_t dataSize = 0;
    std::array<uint8_t, 32> sha256{};
};

/** Progress of a backup or restore: bytes of file data done so far, out of the total. */
using SaveProgressFn = std::function<void(uint64_t done, uint64_t total)>;

/**
 * Walks the whole tree, then writes the archive to `out` in canonical order, hashing as it goes.
 * Throws FormatError for a path an archive cannot hold, std::runtime_error when a file's size
 * changes while it is read.
 */
SaveArchiveInfo writeSaveArchive(SaveTreeReader& tree, const SaveSink& out, const SaveProgressFn& progress = {});

struct SaveArchiveEntry {
    std::string path;
    bool dir = false;
    uint64_t size = 0;
    /** Where the entry's data starts in the archive. */
    uint64_t offset = 0;
};

struct SaveArchiveListing {
    std::vector<SaveArchiveEntry> entries;
    uint32_t files = 0;
    uint64_t dataSize = 0;
};

/**
 * Lists and validates an archive without extracting it: ustar or GNU headers with good checksums,
 * only files and directories, safe relative paths (`./` prefixes allowed), no duplicates, nothing
 * inside a file, and two zero blocks at the end followed only by zeros. Throws FormatError.
 */
SaveArchiveListing listSaveArchive(const Reader& archive);

/**
 * Replaces everything in the save with the archive's contents. Validates the whole archive first,
 * so a bad one fails before the save is touched. Commits after each file, and part way through a
 * file whenever the uncommitted bytes would exceed `journalBytes` (0: only after each file).
 */
void restoreSaveArchive(const Reader& archive, SaveTreeWriter& save, uint64_t journalBytes,
    const SaveProgressFn& progress = {});

/** "0123…EF": 32 uppercase hex digits for an account UID stored as two u64s. */
std::string accountIdHex(uint64_t uid0, uint64_t uid1);

/** Lowercase hex of a SHA-256. */
std::string sha256Hex(const std::array<uint8_t, 32>& digest);

} // namespace nslib
