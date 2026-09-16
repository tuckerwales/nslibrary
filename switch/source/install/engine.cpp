#include "install/engine.hpp"

#include "app/services.hpp"
#include "formats/cnmt.hpp"
#include "formats/container.hpp"
#include "formats/crypto.hpp"
#include "formats/meta.hpp"
#include "formats/ncz.hpp"
#include "formats/pfs0.hpp"
#include "formats/ticket.hpp"
#include "install/app_record.hpp"
#include "install/pipeline.hpp"
#include "install/preflight.hpp"

#ifdef __SWITCH__
#include <dirent.h>
#include <switch.h>
#include <sys/stat.h>
#endif

#include <algorithm>
#include <chrono>
#include <optional>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <vector>

namespace nslib {
namespace {

std::string resultHex(uint32_t rc) {
    char buf[16];
    std::snprintf(buf, sizeof(buf), "0x%X", rc);
    return buf;
}

#ifdef __SWITCH__

void check(Result rc, const char* what) {
    if (R_FAILED(rc)) throw InstallError(resultHex(rc), std::string(what) + " failed (" + resultHex(rc) + ")");
}

bool ieqPrefix(const std::string& name, const std::string& hexId) {
    if (name.size() < hexId.size()) return false;
    for (size_t i = 0; i < hexId.size(); i++) {
        char a = name[i], b = hexId[i];
        if (a >= 'A' && a <= 'F') a = char(a - 'A' + 'a');
        if (b >= 'A' && b <= 'F') b = char(b - 'A' + 'a');
        if (a != b) return false;
    }
    return true;
}

const PartitionEntry* findById(const Partition& p, const std::string& ncaId) {
    for (const auto& e : p.entries) {
        if (ieqPrefix(e.name, ncaId)) return &e;
    }
    return nullptr;
}

const PartitionEntry* findKind(const Partition& p, EntryKind kind, const std::string& stem = {}) {
    for (const auto& e : p.entries) {
        if (e.kind != kind) continue;
        if (stem.empty() || ieqPrefix(e.name, stem)) return &e;
    }
    return nullptr;
}

bool entryIsNcz(const PartitionEntry& e) {
    return e.kind == EntryKind::Ncz || (e.name.size() >= 4 && e.name.compare(e.name.size() - 4, 4, ".ncz") == 0) ||
        (e.name.size() >= 8 && e.name.compare(e.name.size() - 8, 8, ".cnmt.ncz") == 0);
}

class JobFileReader : public Reader {
public:
    JobFileReader(DeviceApiClient& client, int64_t fileId, uint64_t size)
        : client_(client), fileId_(fileId), size_(size) {}

    uint64_t size() const override { return size_; }

    void read(uint64_t offset, void* dst, size_t n) const override {
        size_t got = 0;
        client_.getFile(fileId_, offset, n, [&](const uint8_t* p, size_t m) {
            if (got + m > n) m = n - got;
            std::memcpy(static_cast<uint8_t*>(dst) + got, p, m);
            got += m;
        });
        if (got != n) throw InstallError("0x0", "short read from library file");
    }

private:
    DeviceApiClient& client_;
    int64_t fileId_;
    uint64_t size_;
};

struct ProgressClock {
    InstallEngine::ProgressFn fn;
    std::chrono::steady_clock::time_point start;

    void emit(const std::string& phase, const std::string& item, uint64_t done, uint64_t total) {
        const auto now = std::chrono::steady_clock::now();
        const auto dt = std::chrono::duration<double>(now - start).count();
        JobProgress p;
        p.phase = phase;
        if (!item.empty()) p.item = item;
        p.done = done;
        p.total = total;
        p.bps = dt > 0 ? double(done) / dt : 0;
        if (fn) fn(p);
    }
};

std::vector<uint8_t> readEntry(DeviceApiClient& client, const Job& job, const PartitionEntry& e) {
    std::vector<uint8_t> buf(size_t(e.size));
    size_t got = 0;
    client.getFile(job.fileId, e.offset, e.size, [&](const uint8_t* p, size_t m) {
        std::memcpy(buf.data() + got, p, m);
        got += m;
    });
    buf.resize(got);
    return buf;
}

std::vector<uint8_t> readCnmtFs(const char* mount, const char* pathLabel) {
    std::vector<uint8_t> out;
    DIR* dir = opendir(mount);
    if (!dir) throw InstallError("0x0", std::string("could not list ") + pathLabel);
    while (dirent* ent = readdir(dir)) {
        const std::string name = ent->d_name;
        if (name.size() >= 5 && name.rfind(".cnmt") == name.size() - 5) {
            FILE* f = fopen((std::string(mount) + name).c_str(), "rb");
            if (!f) continue;
            fseek(f, 0, SEEK_END);
            const long sz = ftell(f);
            fseek(f, 0, SEEK_SET);
            if (sz > 0) {
                out.resize(size_t(sz));
                fread(out.data(), 1, size_t(sz), f);
            }
            fclose(f);
            break;
        }
    }
    closedir(dir);
    return out;
}

std::vector<uint8_t> readCnmtFromPlaceholder(NcmContentStorage* cs, const NcmPlaceHolderId* ph, u64 titleId) {
    char path[FS_MAX_PATH]{};
    check(ncmContentStorageGetPlaceHolderPath(cs, path, sizeof(path), ph), "ncmContentStorageGetPlaceHolderPath");
    FsFileSystem fs{};
    Result rc = fsOpenFileSystemWithId(&fs, titleId, FsFileSystemType_ContentMeta, path, FsContentAttributes_None);
    if (R_FAILED(rc)) {
        rc = fsOpenFileSystemWithId(&fs, 0, FsFileSystemType_ContentMeta, path, FsContentAttributes_None);
    }
    check(rc, "fsOpenFileSystemWithId(ContentMeta)");
    if (fsdevMountDevice("nslibcnmt", fs) < 0) {
        fsFsClose(&fs);
        throw InstallError("0x0", "could not mount CNMT filesystem");
    }
    std::vector<uint8_t> out = readCnmtFs("nslibcnmt:/", "CNMT filesystem");
    fsdevUnmountDevice("nslibcnmt");
    if (out.empty()) throw InstallError("0x0", "no .cnmt inside meta NCA");
    return out;
}

NcmContentId contentIdFromHex(const std::string& hex) {
    NcmContentId id{};
    for (int i = 0; i < 16; i++) {
        const char byte[3] = {hex[size_t(i * 2)], hex[size_t(i * 2 + 1)], 0};
        id.c[i] = uint8_t(strtoul(byte, nullptr, 16));
    }
    return id;
}

std::optional<SpaceAvail> spaceOf(NcmStorageId storage) {
    NcmContentStorage cs{};
    if (R_FAILED(ncmOpenContentStorage(&cs, storage))) return std::nullopt;
    s64 free = 0, total = 0;
    const Result a = ncmContentStorageGetFreeSpaceSize(&cs, &free);
    const Result b = ncmContentStorageGetTotalSpaceSize(&cs, &total);
    ncmContentStorageClose(&cs);
    if (R_FAILED(a) || R_FAILED(b)) return std::nullopt;
    return SpaceAvail{uint64_t(free), uint64_t(total)};
}

NcmStorageId ncmId(StorageTarget t) {
    return t == StorageTarget::Nand ? NcmStorageId_BuiltInUser : NcmStorageId_SdCard;
}

std::string sanitizeName(std::string s) {
    for (char& c : s) {
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) {
            c = '_';
        }
    }
    while (!s.empty() && s.back() == '_') s.pop_back();
    if (s.empty()) s = "homebrew";
    return s;
}

struct Rollback {
    NcmContentStorage* cs = nullptr;
    std::vector<NcmPlaceHolderId> placeholders;
    std::vector<NcmContentId> registered;
    bool committed = false;
    ~Rollback() {
        if (!cs) return;
        if (!committed) {
            for (auto& ph : placeholders) ncmContentStorageDeletePlaceHolder(cs, &ph);
            for (auto& id : registered) ncmContentStorageDelete(cs, &id);
        }
        ncmContentStorageClose(cs);
        cs = nullptr;
    }
};

struct InstallGuard {
    bool titleOverride = false;
    InstallGuard() {
        appletSetMediaPlaybackState(true);
        appletSetCpuBoostMode(ApmCpuBoostMode_FastLoad);
        titleOverride = appletGetAppletType() == AppletType_Application;
        if (titleOverride) {
            appletSetAutoSleepDisabled(true);
            appletBeginBlockingHomeButton(0);
        }
    }
    ~InstallGuard() {
        if (titleOverride) {
            appletEndBlockingHomeButton();
            appletSetAutoSleepDisabled(false);
        }
        appletSetCpuBoostMode(ApmCpuBoostMode_Normal);
        appletSetMediaPlaybackState(false);
    }
};

uint64_t ncaSizeForEntry(JobFileReader& reader, const PartitionEntry& e) {
    if (!entryIsNcz(e)) return e.size;
    SliceReader slice(reader, e.offset, e.size);
    return nczOutputSize(parseNczHeader(slice));
}

PipelineStats streamEntry(DeviceApiClient& client, const Job& job, const PartitionEntry& e, NcmContentStorage* cs,
    const NcmPlaceHolderId* ph, uint64_t ncaSize, CancelToken cancel, bool hash, uint64_t maxWindow,
    ProgressClock& clock, const std::string& phase)
{
    auto readAll = [&](const std::function<void(const uint8_t*, size_t)>& sink) {
        client.getFile(job.fileId, e.offset, e.size, sink);
    };
    auto write = [&](uint64_t off, const uint8_t* p, size_t n) {
        check(ncmContentStorageWritePlaceHolder(cs, ph, s64(off), p, n), "ncmContentStorageWritePlaceHolder");
    };
    return runPipeline(readAll, write, entryIsNcz(e), ncaSize, cancel, hash, maxWindow,
        [&](uint64_t done, uint64_t total) { clock.emit(phase, e.name, done, total); });
}

void installNro(DeviceApiClient& client, const Job& job, CancelToken cancel, ProgressClock& clock) {
    const std::string name = sanitizeName(job.name);
    mkdir("sdmc:/switch", 0777);
    const std::string dir = "sdmc:/switch/" + name;
    mkdir(dir.c_str(), 0777);
    const std::string part = dir + "/" + name + ".nro.part";
    const std::string dest = dir + "/" + name + ".nro";
    FILE* f = fopen(part.c_str(), "wb");
    if (!f) throw InstallError("0x0", "could not write " + part);
    uint64_t written = 0;
    try {
        client.getFile(job.fileId, 0, job.size, [&](const uint8_t* p, size_t n) {
            cancel.check();
            if (fwrite(p, 1, n, f) != n) throw InstallError("0x0", "short write for homebrew");
            written += n;
            clock.emit("content", name + ".nro", written, job.size);
        });
    } catch (...) {
        fclose(f);
        std::remove(part.c_str());
        throw;
    }
    fclose(f);
    std::remove(dest.c_str());
    if (std::rename(part.c_str(), dest.c_str()) != 0) {
        std::remove(part.c_str());
        throw InstallError("0x0", "could not finalize " + dest);
    }
}

#endif

} // namespace

InstallEngine::InstallEngine(DeviceApiClient& client, std::atomic<bool>* cancel, InstallOptions opt)
    : client_(client), cancel_(cancel), opt_(opt) {}

void InstallEngine::install(const Job& job, ProgressFn progress) {
#ifndef __SWITCH__
    (void)job;
    (void)progress;
    throw InstallError("0x0", "install engine requires a Switch");
#else
    InstallGuard guard;
    CancelToken cancel(cancel_);
    ProgressClock clock;
    clock.fn = std::move(progress);
    clock.start = std::chrono::steady_clock::now();
    clock.emit("preflight", "", 0, job.size);

    if (job.format == "nro") {
        installNro(client_, job, cancel, clock);
        clock.emit("record", job.name, job.size, job.size);
        return;
    }

    JobFileReader reader(client_, job.fileId, job.size);
    const Partition entries = listInstallEntries(reader, job.format);

    const auto sd = spaceOf(NcmStorageId_SdCard);
    SpaceAvail nand{};
    if (auto n = spaceOf(NcmStorageId_BuiltInUser)) nand = *n;
    StorageTarget storage = pickStorage(job.target.empty() ? "sd" : job.target, job.size, sd, nand);

    if (batteryShouldWarn(batteryPercent(), batteryCharging())) {
        clock.emit("preflight", "Battery is below 15% and not charging", 0, job.size);
    }

    const uint64_t maxWindow = isAppletMode() ? kNczMaxAppletWindow : kNczMaxOverrideWindow;

    NcmContentStorage cs{};
    check(ncmOpenContentStorage(&cs, ncmId(storage)), "ncmOpenContentStorage");
    Rollback rb;
    rb.cs = &cs;

    clock.emit("ticket", "", 0, job.size);
    for (const auto& e : entries.entries) {
        if (e.kind != EntryKind::Tik) continue;
        cancel.check();
        auto tik = readEntry(client_, job, e);
        std::string stem = e.name.substr(0, e.name.find('.'));
        const PartitionEntry* cert = findKind(entries, EntryKind::Cert, stem);
        if (!cert) throw InstallError("0x0", "ticket is missing its certificate");
        auto certBytes = readEntry(client_, job, *cert);
        const Result rc = esImportTicket(tik.data(), tik.size(), certBytes.data(), certBytes.size());
        if (R_FAILED(rc)) {
            throw InstallError(resultHex(rc),
                "ticket import failed (" + resultHex(rc) + "). Sigpatches may be required.");
        }
    }

    bool any = false;
    for (const auto& metaEntry : entries.entries) {
        if (metaEntry.kind != EntryKind::Cnmt) continue;
        any = true;
        cancel.check();
        clock.emit("meta", metaEntry.name, 0, metaEntry.size);

        std::string idHex = metaEntry.name.substr(0, 32);
        NcmContentId metaId = contentIdFromHex(idHex);
        const uint64_t metaSize = ncaSizeForEntry(reader, metaEntry);

        bool has = false;
        ncmContentStorageHas(&cs, &has, &metaId);

        NcmPlaceHolderId ph{};
        std::vector<uint8_t> cnmtBytes;
        if (!has) {
            check(ncmContentStorageGeneratePlaceHolderId(&cs, &ph), "ncmContentStorageGeneratePlaceHolderId");
            check(ncmContentStorageCreatePlaceHolder(&cs, &metaId, &ph, s64(metaSize)),
                "ncmContentStorageCreatePlaceHolder");
            rb.placeholders.push_back(ph);
            const auto stats = streamEntry(client_, job, metaEntry, &cs, &ph, metaSize, cancel, opt_.verifyHash,
                maxWindow, clock, "meta");
            if (stats.ncaBytes != metaSize) throw InstallError("0x0", "meta NCA size mismatch");
            cnmtBytes = readCnmtFromPlaceholder(&cs, &ph, 0);
            check(ncmContentStorageFlushPlaceHolder(&cs), "ncmContentStorageFlushPlaceHolder");
            check(ncmContentStorageRegister(&cs, &metaId, &ph), "ncmContentStorageRegister(meta)");
            rb.placeholders.pop_back();
            rb.registered.push_back(metaId);
        } else {
            char path[FS_MAX_PATH]{};
            check(ncmContentStorageGetPath(&cs, path, sizeof(path), &metaId), "ncmContentStorageGetPath");
            FsFileSystem fs{};
            check(fsOpenFileSystemWithId(&fs, 0, FsFileSystemType_ContentMeta, path, FsContentAttributes_None),
                "fsOpenFileSystemWithId(existing meta)");
            if (fsdevMountDevice("nslibcnmt", fs) < 0) throw InstallError("0x0", "mount existing CNMT failed");
            cnmtBytes = readCnmtFs("nslibcnmt:/", "existing CNMT");
            fsdevUnmountDevice("nslibcnmt");
        }

        const CnmtInfo cnmt = parseCnmt(cnmtBytes);
        if (cnmt.hasRequiredSystemVersion && firmwareTooNew(cnmt.requiredSystemVersion, currentFirmwarePacked())) {
            clock.emit("preflight", "Required firmware is newer than this console", 0, 1);
        }

        uint64_t remaining = metaSize;
        for (const auto& rec : cnmt.contents) {
            if (rec.type == uint8_t(CnmtContentType::DeltaFragment)) continue;
            remaining += rec.size;
        }
        SpaceAvail chosen{};
        if (auto sp = spaceOf(ncmId(storage))) chosen = *sp;
        if (chosen.free < remaining) {
            throw InstallError("preflight", "Not enough space on " + storageName(storage) + " for this title");
        }

        clock.emit("content", "", 0, cnmt.installSize);
        for (const auto& rec : cnmt.contents) {
            if (rec.type == uint8_t(CnmtContentType::DeltaFragment)) continue;
            if (rec.type == uint8_t(CnmtContentType::Meta)) continue;
            cancel.check();
            NcmContentId cid{};
            std::memcpy(cid.c, rec.ncaIdBytes, 16);
            bool already = false;
            ncmContentStorageHas(&cs, &already, &cid);
            if (already) continue;
            const PartitionEntry* src = findById(entries, rec.ncaId);
            if (!src) throw InstallError("0x0", "container is missing " + rec.ncaId);
            const uint64_t ncaSize = rec.size ? rec.size : ncaSizeForEntry(reader, *src);

            NcmPlaceHolderId cph{};
            check(ncmContentStorageGeneratePlaceHolderId(&cs, &cph), "ncmContentStorageGeneratePlaceHolderId");
            check(ncmContentStorageCreatePlaceHolder(&cs, &cid, &cph, s64(ncaSize)),
                "ncmContentStorageCreatePlaceHolder");
            rb.placeholders.push_back(cph);
            const auto stats = streamEntry(client_, job, *src, &cs, &cph, ncaSize, cancel, opt_.verifyHash, maxWindow,
                clock, "content");
            if (stats.ncaBytes != ncaSize) {
                throw InstallError("0x0", "NCA size mismatch for " + src->name);
            }
            if (opt_.verifyHash && !rec.sha256.empty()) {
                const std::string got = hexLower(stats.sha256.data(), 32);
                if (got != rec.sha256) {
                    throw InstallError("hash_mismatch",
                        "NCA hash mismatch for " + rec.ncaId + " (file may be corrupt)");
                }
                if (std::memcmp(stats.sha256.data(), rec.ncaIdBytes, 16) != 0) {
                    throw InstallError("hash_mismatch", "NCA id prefix mismatch for " + rec.ncaId);
                }
            }
            check(ncmContentStorageFlushPlaceHolder(&cs), "ncmContentStorageFlushPlaceHolder");
            check(ncmContentStorageRegister(&cs, &cid, &cph), "ncmContentStorageRegister");
            rb.placeholders.pop_back();
            rb.registered.push_back(cid);
        }

        clock.emit("commit", cnmt.titleId, 0, 1);
        const auto blob = buildInstallContentMeta(cnmt, metaId.c, metaSize);
        NcmContentMetaDatabase db{};
        check(ncmOpenContentMetaDatabase(&db, ncmId(storage)), "ncmOpenContentMetaDatabase");
        NcmContentMetaKey key{};
        key.id = cnmt.titleIdValue;
        key.version = cnmt.version;
        key.type = cnmt.rawType;
        key.install_type = NcmContentInstallType_Full;
        Result setRc = ncmContentMetaDatabaseSet(&db, &key, blob.data(), blob.size());
        if (R_SUCCEEDED(setRc)) setRc = ncmContentMetaDatabaseCommit(&db);
        ncmContentMetaDatabaseClose(&db);
        check(setRc, "ncmContentMetaDatabaseSet");

        clock.emit("record", cnmt.applicationId, 0, 1);
        check(appRecordCommit(cnmt.applicationIdValue, ncmId(storage), key), "ns application record");
    }

    if (!any) throw InstallError("0x0", "container has no CNMT");
    rb.committed = true;
    clock.emit("record", job.name, job.size, job.size);
#endif
}

} // namespace nslib
