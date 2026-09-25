#include "saves/console.hpp"

#include "formats/crypto.hpp"

#include <switch.h>

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <map>
#include <memory>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>

namespace nslib {
namespace {

constexpr size_t kReadChunk = 256 * 1024;
/** Commit interval for a game whose control data is gone, so its journal size is unknown. */
constexpr uint64_t kFallbackJournal = 1024 * 1024;

/** A fixed-size, possibly unterminated char field as a string (newlib has no strnlen in strict C++17). */
std::string fieldString(const char* field, size_t size) {
    size_t n = 0;
    while (n < size && field[n]) n++;
    return std::string(field, n);
}

std::string resultText(Result rc) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "0x%X (%04u-%04u)", rc, 2000 + R_MODULE(rc), R_DESCRIPTION(rc));
    return buf;
}

[[noreturn]] void fail(const std::string& what, Result rc) {
    throw std::runtime_error(what + " failed: " + resultText(rc));
}

std::string upperHex16(uint64_t v) {
    char buf[17];
    std::snprintf(buf, sizeof(buf), "%016llX", static_cast<unsigned long long>(v));
    return buf;
}

struct AppControl {
    std::string name;
    uint64_t accountJournal = 0;
    uint64_t deviceJournal = 0;
};

AppControl appControl(uint64_t applicationId) {
    AppControl out;
    auto data = std::make_unique<NsApplicationControlData>();
    u64 size = 0;
    const Result rc = nsGetApplicationControlData(
        NsApplicationControlSource_Storage, applicationId, data.get(), sizeof(NsApplicationControlData), &size);
    if (R_FAILED(rc) || size < sizeof(NacpStruct)) return out;
    NacpLanguageEntry* entry = nullptr;
    if (R_SUCCEEDED(nacpGetLanguageEntry(&data->nacp, &entry)) && entry) {
        out.name = fieldString(entry->name, sizeof(entry->name));
    }
    out.accountJournal = data->nacp.user_account_save_data_journal_size;
    out.deviceJournal = data->nacp.device_save_data_journal_size;
    return out;
}

std::string nickname(AccountUid uid) {
    AccountProfile profile;
    if (R_FAILED(accountGetProfile(&profile, uid))) return {};
    AccountProfileBase base{};
    std::string name;
    if (R_SUCCEEDED(accountProfileGet(&profile, nullptr, &base))) {
        name = fieldString(base.nickname, sizeof(base.nickname));
    }
    accountProfileClose(&profile);
    return name;
}

/** An open save filesystem, closed when it goes out of scope. */
class SaveMount {
public:
    explicit SaveMount(const ConsoleSave& save) {
        FsSaveDataAttribute attr{};
        attr.application_id = save.applicationId;
        attr.uid.uid[0] = save.uid0;
        attr.uid.uid[1] = save.uid1;
        attr.save_data_type = save.type == "device" ? FsSaveDataType_Device : FsSaveDataType_Account;
        attr.save_data_rank = save.rank;
        attr.save_data_index = save.index;
        const Result rc = fsOpenSaveDataFileSystem(&fs_, FsSaveDataSpaceId_User, &attr);
        if (R_FAILED(rc)) {
            throw std::runtime_error("Could not open the save " + resultText(rc) +
                ". If the game is running, close it from HOME and try again.");
        }
    }
    ~SaveMount() { fsFsClose(&fs_); }
    SaveMount(const SaveMount&) = delete;
    SaveMount& operator=(const SaveMount&) = delete;

    FsFileSystem* fs() { return &fs_; }

private:
    FsFileSystem fs_{};
};

std::string fsPath(const std::string& path) { return "/" + path; }

class FsSaveReader : public SaveTreeReader {
public:
    explicit FsSaveReader(FsFileSystem* fs) : fs_(fs), buffer_(kReadChunk) {}

    std::vector<SaveTreeEntry> list(const std::string& dir) override {
        FsDir d;
        const std::string path = dir.empty() ? "/" : fsPath(dir);
        Result rc = fsFsOpenDirectory(fs_, path.c_str(), FsDirOpenMode_ReadDirs | FsDirOpenMode_ReadFiles, &d);
        if (R_FAILED(rc)) fail("Listing " + path, rc);
        std::vector<SaveTreeEntry> out;
        std::vector<FsDirectoryEntry> entries(32);
        for (;;) {
            s64 n = 0;
            rc = fsDirRead(&d, &n, entries.size(), entries.data());
            if (R_FAILED(rc)) {
                fsDirClose(&d);
                fail("Listing " + path, rc);
            }
            if (n <= 0) break;
            for (s64 i = 0; i < n; i++) {
                const auto& e = entries[size_t(i)];
                SaveTreeEntry entry;
                entry.name = fieldString(e.name, sizeof(e.name));
                entry.dir = e.type == FsDirEntryType_Dir;
                entry.size = entry.dir ? 0 : uint64_t(e.file_size);
                out.push_back(std::move(entry));
            }
        }
        fsDirClose(&d);
        return out;
    }

    void read(const std::string& path, uint64_t size, const SaveSink& sink) override {
        FsFile f;
        const std::string p = fsPath(path);
        Result rc = fsFsOpenFile(fs_, p.c_str(), FsOpenMode_Read, &f);
        if (R_FAILED(rc)) fail("Opening " + p, rc);
        try {
            for (uint64_t at = 0; at < size;) {
                const u64 want = std::min<u64>(buffer_.size(), size - at);
                u64 got = 0;
                rc = fsFileRead(&f, s64(at), buffer_.data(), want, FsReadOption_None, &got);
                if (R_FAILED(rc)) fail("Reading " + p, rc);
                if (got == 0) break;  // shorter than listed: writeSaveArchive reports it
                sink(buffer_.data(), size_t(got));
                at += got;
            }
        } catch (...) {
            fsFileClose(&f);
            throw;
        }
        fsFileClose(&f);
    }

private:
    FsFileSystem* fs_;
    std::vector<uint8_t> buffer_;
};

class FsSaveWriter : public SaveTreeWriter {
public:
    explicit FsSaveWriter(FsFileSystem* fs) : fs_(fs) {}
    ~FsSaveWriter() override { closeFile(); }

    void clear() override {
        const Result rc = fsFsCleanDirectoryRecursively(fs_, "/");
        if (R_FAILED(rc)) fail("Clearing the save", rc);
    }

    void makeDir(const std::string& path) override {
        const std::string p = fsPath(path);
        const Result rc = fsFsCreateDirectory(fs_, p.c_str());
        if (R_FAILED(rc)) fail("Creating " + p, rc);
    }

    void beginFile(const std::string& path, uint64_t size) override {
        closeFile();
        path_ = fsPath(path);
        Result rc = fsFsCreateFile(fs_, path_.c_str(), s64(size), 0);
        if (R_FAILED(rc)) fail("Creating " + path_, rc);
        openFile();
        offset_ = 0;
    }

    void write(const uint8_t* data, size_t n) override {
        const Result rc = fsFileWrite(&file_, s64(offset_), data, n, FsWriteOption_None);
        if (R_FAILED(rc)) fail("Writing " + path_, rc);
        offset_ += n;
    }

    void endFile() override {
        closeFile();
        path_.clear();
    }

    void commit() override {
        // A file must be closed for its writes to be part of the commit; reopen it to carry on.
        const bool reopen = open_;
        closeFile();
        const Result rc = fsFsCommit(fs_);
        if (R_FAILED(rc)) fail("Committing the save", rc);
        if (reopen) openFile();
    }

private:
    FsFileSystem* fs_;
    FsFile file_{};
    bool open_ = false;
    std::string path_;
    uint64_t offset_ = 0;

    void openFile() {
        const Result rc = fsFsOpenFile(fs_, path_.c_str(), FsOpenMode_Write, &file_);
        if (R_FAILED(rc)) fail("Opening " + path_, rc);
        open_ = true;
    }

    void closeFile() {
        if (!open_) return;
        fsFileFlush(&file_);
        fsFileClose(&file_);
        open_ = false;
    }
};

/** A staged archive on the SD card, read by offset for listing and restoring. */
class StagedArchive : public Reader {
public:
    explicit StagedArchive(const std::string& path) {
        file_ = std::fopen(path.c_str(), "rb");
        if (!file_) throw std::runtime_error("Could not open " + path);
        std::fseek(file_, 0, SEEK_END);
        size_ = uint64_t(std::ftell(file_));
    }
    ~StagedArchive() override {
        if (file_) std::fclose(file_);
    }
    StagedArchive(const StagedArchive&) = delete;
    StagedArchive& operator=(const StagedArchive&) = delete;

    uint64_t size() const override { return size_; }

    void read(uint64_t offset, void* dst, size_t n) const override {
        if (offset > size_ || n > size_ - offset) throw FormatError("TRUNCATED", "read past the end of the archive");
        if (std::fseek(file_, long(offset), SEEK_SET) != 0 || std::fread(dst, 1, n, file_) != n) {
            throw std::runtime_error("Could not read the staged archive on the SD card");
        }
    }

    /** Sequential reads for uploading. */
    size_t next(uint8_t* dst, size_t max) {
        if (std::fseek(file_, long(cursor_), SEEK_SET) != 0) return 0;
        const size_t n = std::fread(dst, 1, max, file_);
        cursor_ += n;
        return n;
    }

private:
    std::FILE* file_ = nullptr;
    uint64_t size_ = 0;
    uint64_t cursor_ = 0;
};

void ensureStagingDir() {
    mkdir("sdmc:/config", 0777);
    mkdir("sdmc:/config/nslibrary", 0777);
    mkdir(kSaveStagingDir, 0777);
}

/** Deletes the staged file however the operation ends. */
struct StagedFile {
    std::string path;
    explicit StagedFile(std::string p) : path(std::move(p)) {
        ensureStagingDir();
        std::remove(path.c_str());
    }
    ~StagedFile() { std::remove(path.c_str()); }
};

struct PackedSave {
    SaveArchiveInfo info;
};

PackedSave packSave(const ConsoleSave& save, const std::string& path, const SaveStepFn& progress) {
    std::FILE* out = std::fopen(path.c_str(), "wb");
    if (!out) throw std::runtime_error("Could not write to the SD card (" + path + ")");
    PackedSave packed;
    try {
        SaveMount mount(save);
        FsSaveReader reader(mount.fs());
        packed.info = writeSaveArchive(reader, [&](const uint8_t* p, size_t n) {
            if (std::fwrite(p, 1, n, out) != n) throw std::runtime_error("The SD card is full or read-only");
        }, [&](uint64_t done, uint64_t total) {
            if (progress) progress("app/saves/phase_reading", done, total);
        });
    } catch (...) {
        std::fclose(out);
        throw;
    }
    if (std::fclose(out) != 0) throw std::runtime_error("The SD card is full or read-only");
    return packed;
}

SaveUploadQuery uploadQuery(const ConsoleSave& save, const std::string& origin, const std::string& sha256) {
    SaveUploadQuery q;
    q.app = save.appId;
    q.type = save.type;
    q.user = save.userId;
    q.userName = save.userName;
    q.name = save.gameName;
    q.origin = origin;
    q.sha256 = sha256;
    return q;
}

SaveUploadResult uploadStaged(const ConsoleSave& save, const std::string& origin, const std::string& path,
    const std::string& sha256, DeviceApiClient& client, const SaveStepFn& progress)
{
    StagedArchive archive(path);
    const uint64_t total = archive.size();
    uint64_t sent = 0;
    if (progress) progress("app/saves/phase_uploading", 0, total);
    return client.uploadSave(uploadQuery(save, origin, sha256), total, [&](uint8_t* dst, size_t max) {
        const size_t n = archive.next(dst, max);
        sent += n;
        if (progress) progress("app/saves/phase_uploading", sent, total);
        return n;
    });
}

} // namespace

bool isSameSave(const ConsoleSave& save, const SaveBackup& backup) {
    return backup.app == save.appId && backup.type == save.type && backup.user == save.userId;
}

std::vector<ConsoleSave> listConsoleSaves(const std::function<void(size_t done, size_t total)>& progress) {
    FsSaveDataInfoReader reader;
    Result rc = fsOpenSaveDataInfoReader(&reader, FsSaveDataSpaceId_User);
    if (R_FAILED(rc)) fail("Listing saves", rc);
    std::vector<FsSaveDataInfo> infos;
    std::vector<FsSaveDataInfo> page(64);
    for (;;) {
        s64 n = 0;
        rc = fsSaveDataInfoReaderRead(&reader, page.data(), page.size(), &n);
        if (R_FAILED(rc) || n <= 0) break;
        infos.insert(infos.end(), page.begin(), page.begin() + n);
    }
    fsSaveDataInfoReaderClose(&reader);

    std::map<uint64_t, AppControl> apps;
    std::map<std::pair<uint64_t, uint64_t>, std::string> users;
    std::vector<ConsoleSave> out;
    size_t looked = 0;
    for (const auto& info : infos) {
        if (progress) progress(looked++, infos.size());
        const bool account = info.save_data_type == FsSaveDataType_Account;
        const bool device = info.save_data_type == FsSaveDataType_Device;
        // Rank 1 is the secondary copy some saves keep; back up what the game reads.
        if ((!account && !device) || info.application_id == 0 || info.save_data_rank != FsSaveDataRank_Primary) continue;
        ConsoleSave save;
        save.applicationId = info.application_id;
        save.appId = upperHex16(info.application_id);
        save.type = account ? "account" : "device";
        save.rank = info.save_data_rank;
        save.index = info.save_data_index;
        if (account) {
            save.uid0 = info.uid.uid[0];
            save.uid1 = info.uid.uid[1];
            save.userId = accountIdHex(save.uid0, save.uid1);
            const auto key = std::make_pair(save.uid0, save.uid1);
            auto it = users.find(key);
            if (it == users.end()) it = users.emplace(key, nickname(info.uid)).first;
            save.userName = it->second;
        }
        auto app = apps.find(info.application_id);
        if (app == apps.end()) app = apps.emplace(info.application_id, appControl(info.application_id)).first;
        save.gameName = app->second.name;
        const uint64_t journal = account ? app->second.accountJournal : app->second.deviceJournal;
        save.journalBytes = journal ? journal : kFallbackJournal;
        out.push_back(std::move(save));
    }
    std::sort(out.begin(), out.end(), [](const ConsoleSave& a, const ConsoleSave& b) {
        const std::string& an = a.gameName.empty() ? a.appId : a.gameName;
        const std::string& bn = b.gameName.empty() ? b.appId : b.gameName;
        if (an != bn) return an < bn;
        if (a.type != b.type) return a.type < b.type;
        return a.userName < b.userName;
    });
    return out;
}

void clearSaveStaging() {
    DIR* dir = opendir(kSaveStagingDir);
    if (!dir) return;
    while (dirent* e = readdir(dir)) {
        const std::string name = e->d_name;
        if (name == "." || name == "..") continue;
        std::remove((std::string(kSaveStagingDir) + "/" + name).c_str());
    }
    closedir(dir);
}

SaveBackupResult backupConsoleSave(const ConsoleSave& save, const std::string& origin, DeviceApiClient& client,
    const std::string& unchangedSince, const SaveStepFn& progress)
{
    StagedFile staged(std::string(kSaveStagingDir) + "/backup.tar");
    const auto packed = packSave(save, staged.path, progress);
    const std::string sha = sha256Hex(packed.info.sha256);
    SaveBackupResult result;
    result.bytes = packed.info.bytes;
    if (!unchangedSince.empty() && unchangedSince == sha) {
        result.unchanged = true;
        return result;
    }
    const auto uploaded = uploadStaged(save, origin, staged.path, sha, client, progress);
    result.backup = uploaded.backup;
    result.unchanged = uploaded.dup;
    return result;
}

void restoreConsoleSave(const ConsoleSave& save, const SaveBackup& backup, DeviceApiClient& client,
    const SaveStepFn& progress)
{
    StagedFile staged(std::string(kSaveStagingDir) + "/restore.tar");
    {
        std::FILE* out = std::fopen(staged.path.c_str(), "wb");
        if (!out) throw std::runtime_error("Could not write to the SD card (" + staged.path + ")");
        Sha256 hash;
        uint64_t got = 0;
        try {
            if (progress) progress("app/saves/phase_downloading", 0, backup.size);
            client.downloadSave(backup.id, backup.size, [&](const uint8_t* p, size_t n) {
                if (std::fwrite(p, 1, n, out) != n) throw std::runtime_error("The SD card is full or read-only");
                hash.update(p, n);
                got += n;
                if (progress) progress("app/saves/phase_downloading", got, backup.size);
            });
        } catch (...) {
            std::fclose(out);
            throw;
        }
        if (std::fclose(out) != 0) throw std::runtime_error("The SD card is full or read-only");
        std::array<uint8_t, 32> digest{};
        hash.final(digest.data());
        if (got != backup.size || sha256Hex(digest) != backup.sha256) {
            throw std::runtime_error("The backup arrived damaged (its SHA-256 does not match). Try again.");
        }
    }

    StagedArchive archive(staged.path);
    const auto listing = listSaveArchive(archive);
    {
        SaveMount mount(save);
        s64 capacity = 0;
        if (R_SUCCEEDED(fsFsGetTotalSpace(mount.fs(), "/", &capacity)) && capacity > 0 &&
            listing.dataSize > uint64_t(capacity))
        {
            throw std::runtime_error("This backup does not fit in the game's save on this console.");
        }
    }

    // Keep what is there now, so a restore of the wrong backup can be undone.
    backupConsoleSave(save, "pre-restore", client, {}, progress);

    SaveMount mount(save);
    FsSaveWriter writer(mount.fs());
    restoreSaveArchive(archive, writer, save.journalBytes, [&](uint64_t done, uint64_t total) {
        if (progress) progress("app/saves/phase_writing", done, total);
    });
}

} // namespace nslib
