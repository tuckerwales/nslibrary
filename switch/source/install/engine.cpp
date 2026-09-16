#include "install/engine.hpp"

#include "formats/cnmt.hpp"
#include "formats/meta.hpp"
#include "formats/pfs0.hpp"
#include "formats/ticket.hpp"
#include "install/app_record.hpp"
#include "install/ncz.hpp"

#ifdef __SWITCH__
#include <dirent.h>
#include <switch.h>
#endif

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
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
    Job job;
    InstallEngine::ProgressFn fn;
    std::chrono::steady_clock::time_point last;
    uint64_t lastBytes = 0;
    std::chrono::steady_clock::time_point start;

    void emit(const std::string& phase, const std::string& item, uint64_t done, uint64_t total) {
        const auto now = std::chrono::steady_clock::now();
        double bps = 0;
        const auto dt = std::chrono::duration<double>(now - start).count();
        if (dt > 0) bps = double(done) / dt;
        JobProgress p;
        p.phase = phase;
        if (!item.empty()) p.item = item;
        p.done = done;
        p.total = total;
        p.bps = bps;
        if (fn) fn(p);
        last = now;
        lastBytes = done;
    }
};

void throwIfCancel(std::atomic<bool>* cancel) {
    if (cancel && cancel->load()) throw InstallError("0x0", "cancelled");
}

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

void writePlaceholder(NcmContentStorage* cs, const NcmPlaceHolderId* ph, DeviceApiClient& client, const Job& job,
    const PartitionEntry& e, ProgressClock& clock, const std::string& phase, std::atomic<bool>* cancel)
{
    uint64_t written = 0;
    client.getFile(job.fileId, e.offset, e.size, [&](const uint8_t* p, size_t m) {
        throwIfCancel(cancel);
        check(ncmContentStorageWritePlaceHolder(cs, ph, s64(written), p, m), "ncmContentStorageWritePlaceHolder");
        written += m;
        clock.emit(phase, e.name, written, e.size);
    });
    if (written != e.size) throw InstallError("0x0", "short write for " + e.name);
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
    std::vector<uint8_t> out;
    DIR* dir = opendir("nslibcnmt:/");
    if (!dir) {
        fsdevUnmountDevice("nslibcnmt");
        throw InstallError("0x0", "could not list CNMT filesystem");
    }
    while (dirent* ent = readdir(dir)) {
        const std::string name = ent->d_name;
        if (name.size() >= 5 && name.rfind(".cnmt") == name.size() - 5) {
            FILE* f = fopen(("nslibcnmt:/" + name).c_str(), "rb");
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

#endif

} // namespace

InstallEngine::InstallEngine(DeviceApiClient& client, std::atomic<bool>* cancel)
    : client_(client), cancel_(cancel) {}

void InstallEngine::install(const Job& job, ProgressFn progress) {
#ifndef __SWITCH__
    (void)job;
    (void)progress;
    throw InstallError("0x0", "install engine requires a Switch");
#else
    if (job.format != "nsp") {
        throw InstallError("0x0", job.format == "nsz" || job.format == "xcz" || job.format == "xci"
                ? nczUnsupportedMessage()
                : ("unsupported format " + job.format));
    }

    appletSetMediaPlaybackState(true);
    appletSetCpuBoostMode(ApmCpuBoostMode_FastLoad);

    struct Guard {
        ~Guard() {
            appletSetCpuBoostMode(ApmCpuBoostMode_Normal);
            appletSetMediaPlaybackState(false);
        }
    } guard;

    ProgressClock clock;
    clock.job = job;
    clock.fn = std::move(progress);
    clock.start = std::chrono::steady_clock::now();
    clock.emit("preflight", "", 0, job.size);

    JobFileReader reader(client_, job.fileId, job.size);
    const Partition pfs0 = parsePfs0(reader, 0, job.size);
    for (const auto& e : pfs0.entries) {
        if (e.kind == EntryKind::Ncz) throw InstallError("0x0", nczUnsupportedMessage());
    }

    NcmContentStorage cs{};
    check(ncmOpenContentStorage(&cs, NcmStorageId_SdCard), "ncmOpenContentStorage(SdCard)");
    struct CsGuard {
        NcmContentStorage* cs;
        std::vector<NcmPlaceHolderId> placeholders;
        ~CsGuard() {
            for (auto& ph : placeholders) ncmContentStorageDeletePlaceHolder(cs, &ph);
            ncmContentStorageClose(cs);
        }
    } csGuard{&cs, {}};

    clock.emit("ticket", "", 0, job.size);
    for (const auto& e : pfs0.entries) {
        if (e.kind != EntryKind::Tik) continue;
        throwIfCancel(cancel_);
        auto tik = readEntry(client_, job, e);
        std::string stem = e.name.substr(0, e.name.find('.'));
        const PartitionEntry* cert = findKind(pfs0, EntryKind::Cert, stem);
        if (!cert) throw InstallError("0x0", "ticket is missing its certificate");
        auto certBytes = readEntry(client_, job, *cert);
        const Result rc = esImportTicket(tik.data(), tik.size(), certBytes.data(), certBytes.size());
        if (R_FAILED(rc)) {
            throw InstallError(resultHex(rc),
                "ticket import failed (" + resultHex(rc) + "). Sigpatches may be required.");
        }
    }

    bool any = false;
    for (const auto& metaEntry : pfs0.entries) {
        if (metaEntry.kind != EntryKind::Cnmt) continue;
        any = true;
        throwIfCancel(cancel_);
        clock.emit("meta", metaEntry.name, 0, metaEntry.size);

        std::string idHex = metaEntry.name.substr(0, 32);
        NcmContentId metaId = contentIdFromHex(idHex);

        bool has = false;
        ncmContentStorageHas(&cs, &has, &metaId);

        NcmPlaceHolderId ph{};
        check(ncmContentStorageGeneratePlaceHolderId(&cs, &ph), "ncmContentStorageGeneratePlaceHolderId");
        if (!has) {
            check(ncmContentStorageCreatePlaceHolder(&cs, &metaId, &ph, s64(metaEntry.size)),
                "ncmContentStorageCreatePlaceHolder");
            csGuard.placeholders.push_back(ph);
            writePlaceholder(&cs, &ph, client_, job, metaEntry, clock, "meta", cancel_);
        } else {
            // Still need a placeholder path to mount? Use registered path after skip.
        }

        std::vector<uint8_t> cnmtBytes;
        if (!has) {
            cnmtBytes = readCnmtFromPlaceholder(&cs, &ph, 0);
            check(ncmContentStorageFlushPlaceHolder(&cs), "ncmContentStorageFlushPlaceHolder");
            check(ncmContentStorageRegister(&cs, &metaId, &ph), "ncmContentStorageRegister(meta)");
            csGuard.placeholders.pop_back();
        } else {
            char path[FS_MAX_PATH]{};
            check(ncmContentStorageGetPath(&cs, path, sizeof(path), &metaId), "ncmContentStorageGetPath");
            FsFileSystem fs{};
            check(fsOpenFileSystemWithId(&fs, 0, FsFileSystemType_ContentMeta, path, FsContentAttributes_None),
                "fsOpenFileSystemWithId(existing meta)");
            if (fsdevMountDevice("nslibcnmt", fs) < 0) throw InstallError("0x0", "mount existing CNMT failed");
            DIR* dir = opendir("nslibcnmt:/");
            if (dir) {
                while (dirent* ent = readdir(dir)) {
                    const std::string name = ent->d_name;
                    if (name.size() >= 5 && name.rfind(".cnmt") == name.size() - 5) {
                        FILE* f = fopen(("nslibcnmt:/" + name).c_str(), "rb");
                        if (!f) continue;
                        fseek(f, 0, SEEK_END);
                        long sz = ftell(f);
                        fseek(f, 0, SEEK_SET);
                        cnmtBytes.resize(size_t(sz));
                        fread(cnmtBytes.data(), 1, size_t(sz), f);
                        fclose(f);
                        break;
                    }
                }
                closedir(dir);
            }
            fsdevUnmountDevice("nslibcnmt");
        }

        const CnmtInfo cnmt = parseCnmt(cnmtBytes);
        clock.emit("content", "", 0, cnmt.installSize);

        for (const auto& rec : cnmt.contents) {
            if (rec.type == uint8_t(CnmtContentType::DeltaFragment)) continue;
            if (rec.type == uint8_t(CnmtContentType::Meta)) continue;
            throwIfCancel(cancel_);
            NcmContentId cid{};
            std::memcpy(cid.c, rec.ncaIdBytes, 16);
            bool already = false;
            ncmContentStorageHas(&cs, &already, &cid);
            if (already) continue;
            const PartitionEntry* src = findById(pfs0, rec.ncaId);
            if (!src) throw InstallError("0x0", "NSP is missing " + rec.ncaId + ".nca");
            if (src->kind == EntryKind::Ncz) throw InstallError("0x0", nczUnsupportedMessage());

            NcmPlaceHolderId cph{};
            check(ncmContentStorageGeneratePlaceHolderId(&cs, &cph), "ncmContentStorageGeneratePlaceHolderId");
            check(ncmContentStorageCreatePlaceHolder(&cs, &cid, &cph, s64(src->size)),
                "ncmContentStorageCreatePlaceHolder");
            csGuard.placeholders.push_back(cph);
            writePlaceholder(&cs, &cph, client_, job, *src, clock, "content", cancel_);
            check(ncmContentStorageFlushPlaceHolder(&cs), "ncmContentStorageFlushPlaceHolder");
            check(ncmContentStorageRegister(&cs, &cid, &cph), "ncmContentStorageRegister");
            csGuard.placeholders.pop_back();
        }

        clock.emit("commit", cnmt.titleId, 0, 1);
        const auto blob = buildInstallContentMeta(cnmt, metaId.c, metaEntry.size);
        NcmContentMetaDatabase db{};
        check(ncmOpenContentMetaDatabase(&db, NcmStorageId_SdCard), "ncmOpenContentMetaDatabase");
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
        check(appRecordCommit(cnmt.applicationIdValue, NcmStorageId_SdCard, key), "ns application record");
    }

    if (!any) throw InstallError("0x0", "NSP has no CNMT");
    clock.emit("record", job.name, job.size, job.size);
#endif
}

} // namespace nslib
