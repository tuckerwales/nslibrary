#include "install/engine.hpp"

#include "app/atomic_file.hpp"
#include "app/services.hpp"
#include "formats/cnmt.hpp"
#include "formats/container.hpp"
#include "formats/crypto.hpp"
#include "formats/meta.hpp"
#include "formats/ncz.hpp"
#include "formats/pfs0.hpp"
#include "formats/ticket.hpp"
#include "install/app_record.hpp"
#include "install/es.hpp"
#include "install/pipeline.hpp"
#include "install/placeholder_journal.hpp"
#include "install/preflight.hpp"

#ifdef __SWITCH__
#include <borealis.hpp>
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

/** Tickets and certificates are a few KB; a header claiming more is corrupt, not a 4 GB read. */
constexpr uint64_t kMaxSmallEntryBytes = 1024 * 1024;

std::vector<uint8_t> readEntry(DeviceApiClient& client, const Job& job, const PartitionEntry& e) {
    if (e.size > kMaxSmallEntryBytes) {
        throw InstallError("0x0", "\"" + e.name + "\" is " + std::to_string(e.size) + " bytes, too large to be a " +
            "ticket or certificate");
    }
    std::vector<uint8_t> buf(size_t(e.size));
    size_t got = 0;
    client.getFile(job.fileId, e.offset, e.size, [&](const uint8_t* p, size_t m) {
        // The transport already clamps to the requested length; clamp again so a transport bug
        // cannot walk off the end of this buffer.
        if (got + m > buf.size()) m = buf.size() - got;
        if (m) std::memcpy(buf.data() + got, p, m);
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
                if (fread(out.data(), 1, size_t(sz), f) != size_t(sz)) out.clear();
            }
            fclose(f);
            break;
        }
    }
    closedir(dir);
    return out;
}

constexpr const char* kCnmtMount = "nslibcnmt";

/** Mounts a ContentMeta filesystem and always unmounts it, even when reading throws. */
class CnmtMount {
public:
    explicit CnmtMount(FsFileSystem fs) {
        if (fsdevMountDevice(kCnmtMount, fs) < 0) {
            fsFsClose(&fs);
            throw InstallError("0x0", "could not mount the CNMT filesystem");
        }
    }
    ~CnmtMount() { fsdevUnmountDevice(kCnmtMount); }
    CnmtMount(const CnmtMount&) = delete;
    CnmtMount& operator=(const CnmtMount&) = delete;
};

std::vector<uint8_t> readCnmtAt(const char* path, u64 titleId, const char* label) {
    FsFileSystem fs{};
    Result rc = fsOpenFileSystemWithId(&fs, titleId, FsFileSystemType_ContentMeta, path, FsContentAttributes_None);
    if (R_FAILED(rc) && titleId != 0) {
        rc = fsOpenFileSystemWithId(&fs, 0, FsFileSystemType_ContentMeta, path, FsContentAttributes_None);
    }
    check(rc, "fsOpenFileSystemWithId(ContentMeta)");
    // A crash mid-install can leave the device name registered; clear it before mounting.
    fsdevUnmountDevice(kCnmtMount);
    CnmtMount mount(fs);
    std::vector<uint8_t> out = readCnmtFs("nslibcnmt:/", label);
    if (out.empty()) throw InstallError("0x0", std::string("no .cnmt inside ") + label);
    return out;
}

std::vector<uint8_t> readCnmtFromPlaceholder(NcmContentStorage* cs, const NcmPlaceHolderId* ph) {
    char path[FS_MAX_PATH]{};
    check(ncmContentStorageGetPlaceHolderPath(cs, path, sizeof(path), ph), "ncmContentStorageGetPlaceHolderPath");
    return readCnmtAt(path, 0, "meta NCA");
}

std::vector<uint8_t> readInstalledCnmt(NcmContentStorage* cs, const NcmContentId* id) {
    char path[FS_MAX_PATH]{};
    check(ncmContentStorageGetPath(cs, path, sizeof(path), id), "ncmContentStorageGetPath");
    return readCnmtAt(path, 0, "installed meta NCA");
}

int hexDigit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/** `hex` must be the 32-character NCA ID; a shorter or non-hex name means a malformed container. */
NcmContentId contentIdFromHex(const std::string& hex, const std::string& what) {
    NcmContentId id{};
    if (hex.size() < 32) {
        throw InstallError("0x0", what + " does not start with a 32-character NCA ID");
    }
    for (int i = 0; i < 16; i++) {
        const int hi = hexDigit(hex[size_t(i * 2)]);
        const int lo = hexDigit(hex[size_t(i * 2 + 1)]);
        if (hi < 0 || lo < 0) {
            throw InstallError("0x0", what + " does not start with a 32-character NCA ID");
        }
        id.c[i] = uint8_t(hi << 4 | lo);
    }
    return id;
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

JournalEntry journalEntry(NcmStorageId storage, const NcmPlaceHolderId& ph) {
    JournalEntry e;
    e.storage = uint8_t(storage);
    std::memcpy(e.id.data(), ph.uuid.uuid, 16);
    return e;
}

/**
 * Undoes a title that did not finish. Each title in a container is committed on its own,
 * so a failure in the second title never removes the first one's content.
 */
struct Rollback {
    NcmContentStorage* cs = nullptr;
    NcmStorageId storage = NcmStorageId_SdCard;
    PlaceholderJournal journal{kPlaceholderJournalPath};
    std::vector<NcmPlaceHolderId> placeholders;
    std::vector<NcmContentId> registered;
    std::optional<NcmContentMetaKey> metaKey;

    NcmPlaceHolderId createPlaceholder(const NcmContentId& id, uint64_t size) {
        NcmPlaceHolderId ph{};
        check(ncmContentStorageGeneratePlaceHolderId(cs, &ph), "ncmContentStorageGeneratePlaceHolderId");
        try {
            journal.add(journalEntry(storage, ph));
        } catch (const std::exception& e) {
            brls::Logger::warning("placeholder journal: {}", e.what());
        }
        placeholders.push_back(ph);
        check(ncmContentStorageCreatePlaceHolder(cs, &id, &ph, s64(size)), "ncmContentStorageCreatePlaceHolder");
        return ph;
    }

    void registerPlaceholder(const NcmContentId& id, const NcmPlaceHolderId& ph, const char* what) {
        check(ncmContentStorageFlushPlaceHolder(cs), "ncmContentStorageFlushPlaceHolder");
        check(ncmContentStorageRegister(cs, &id, &ph), what);
        forgetPlaceholder(ph);
        registered.push_back(id);
    }

    void forgetPlaceholder(const NcmPlaceHolderId& ph) {
        for (auto it = placeholders.begin(); it != placeholders.end(); ++it) {
            if (std::memcmp(it->uuid.uuid, ph.uuid.uuid, 16) == 0) {
                placeholders.erase(it);
                break;
            }
        }
        try {
            journal.remove(journalEntry(storage, ph));
        } catch (...) {
        }
    }

    /** The title is fully recorded; nothing of it should be undone any more. */
    void titleCommitted() {
        placeholders.clear();
        registered.clear();
        metaKey.reset();
    }

    ~Rollback() {
        if (!cs) return;
        for (auto& ph : placeholders) {
            ncmContentStorageDeletePlaceHolder(cs, &ph);
            try {
                journal.remove(journalEntry(storage, ph));
            } catch (...) {
            }
        }
        for (auto& id : registered) ncmContentStorageDelete(cs, &id);
        if (metaKey) {
            NcmContentMetaDatabase db{};
            if (R_SUCCEEDED(ncmOpenContentMetaDatabase(&db, storage))) {
                if (R_SUCCEEDED(ncmContentMetaDatabaseRemove(&db, &*metaKey))) ncmContentMetaDatabaseCommit(&db);
                ncmContentMetaDatabaseClose(&db);
            }
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
        titleOverride = !isAppletMode();
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
    if (fclose(f) != 0) {
        std::remove(part.c_str());
        throw InstallError("0x0", "could not write " + part);
    }
    try {
        replaceFile(part, dest);
    } catch (const std::exception& e) {
        throw InstallError("0x0", e.what());
    }
}

#endif

} // namespace

void cleanupStalePlaceholders() {
#ifdef __SWITCH__
    PlaceholderJournal journal(kPlaceholderJournalPath);
    const auto entries = journal.load();
    if (entries.empty()) return;
    brls::Logger::warning("cleaning up {} placeholder(s) from an interrupted install", entries.size());
    for (const auto& e : entries) {
        NcmContentStorage cs{};
        if (R_FAILED(ncmOpenContentStorage(&cs, NcmStorageId(e.storage)))) continue;
        NcmPlaceHolderId ph{};
        std::memcpy(ph.uuid.uuid, e.id.data(), 16);
        bool has = false;
        if (R_SUCCEEDED(ncmContentStorageHasPlaceHolder(&cs, &has, &ph)) && has) {
            ncmContentStorageDeletePlaceHolder(&cs, &ph);
        }
        ncmContentStorageClose(&cs);
    }
    journal.clear();
#endif
}

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

#ifdef __SWITCH__
    brls::Logger::info("install format={} size={} fileId={}", job.format, job.size, job.fileId);
#endif

    if (job.format == "nro") {
        installNro(client_, job, cancel, clock);
        clock.emit("record", job.name, job.size, job.size);
        return;
    }

    JobFileReader reader(client_, job.fileId, job.size);
    brls::Logger::info("install list entries");
    const Partition entries = listInstallEntries(reader, job.format);
    brls::Logger::info("install entries={}", entries.entries.size());

    // job.size is the compressed size for NSZ/XCZ. Size storage by the NCAs that will be written.
    uint64_t need = 0;
    for (const auto& e : entries.entries) {
        if (e.kind != EntryKind::Nca && e.kind != EntryKind::Ncz && e.kind != EntryKind::Cnmt) continue;
        cancel.check();
        need += ncaSizeForEntry(reader, e);
    }
    if (need == 0) need = job.size;

    const auto sd = storageSpace(false);
    SpaceAvail nand{};
    if (auto n = storageSpace(true)) nand = *n;
    // `need` counts every NCA, including ones already on the console, so only use it to choose for
    // "auto". An explicit SD/NAND target is checked per title below against what will really be written.
    const std::string target = job.target.empty() ? "sd" : job.target;
    StorageTarget storage = StorageTarget::Sd;
    if (target == "auto") {
        try {
            storage = pickStorage("auto", need, sd, nand);
        } catch (const InstallError&) {
            storage = sd && sd->free >= nand.free ? StorageTarget::Sd : StorageTarget::Nand;
        }
    } else {
        storage = pickStorage(target, 0, sd, nand);
    }
    brls::Logger::info("install need={} storage={}", need, storageName(storage));

    const auto warn = [&](const std::string& text) {
        brls::Logger::warning("install warning: {}", text);
        if (opt_.warn) opt_.warn(text);
    };
    if (batteryShouldWarn(batteryPercent(), batteryCharging())) {
        warn("Battery is below 15% and not charging. Plug in the console.");
    }

    const uint64_t maxWindow = isAppletMode() ? kNczMaxAppletWindow : kNczMaxOverrideWindow;

    NcmContentStorage cs{};
    check(ncmOpenContentStorage(&cs, ncmId(storage)), "ncmOpenContentStorage");
    Rollback rb;
    rb.cs = &cs;
    rb.storage = ncmId(storage);

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
    bool firmwareWarned = false;
    for (const auto& metaEntry : entries.entries) {
        if (metaEntry.kind != EntryKind::Cnmt) continue;
        any = true;
        cancel.check();
        clock.emit("meta", metaEntry.name, 0, metaEntry.size);

        NcmContentId metaId = contentIdFromHex(metaEntry.name, "\"" + metaEntry.name + "\"");
        const uint64_t metaSize = ncaSizeForEntry(reader, metaEntry);

        bool has = false;
        ncmContentStorageHas(&cs, &has, &metaId);

        std::vector<uint8_t> cnmtBytes;
        if (!has) {
            SpaceAvail metaSpace{};
            if (auto sp = storageSpace(storage == StorageTarget::Nand)) metaSpace = *sp;
            if (metaSpace.free < metaSize) {
                throw InstallError("preflight", "Not enough space on " + storageName(storage) + " for this title");
            }
            const NcmPlaceHolderId ph = rb.createPlaceholder(metaId, metaSize);
            const auto stats = streamEntry(client_, job, metaEntry, &cs, &ph, metaSize, cancel, opt_.verifyHash,
                maxWindow, clock, "meta");
            if (stats.ncaBytes != metaSize) throw InstallError("0x0", "meta NCA size mismatch");
            if (opt_.verifyHash && std::memcmp(stats.sha256.data(), metaId.c, 16) != 0) {
                throw InstallError("hash_mismatch", "meta NCA hash does not match its name (file may be corrupt)");
            }
            cnmtBytes = readCnmtFromPlaceholder(&cs, &ph);
            rb.registerPlaceholder(metaId, ph, "ncmContentStorageRegister(meta)");
        } else {
            cnmtBytes = readInstalledCnmt(&cs, &metaId);
        }

        const CnmtInfo cnmt = parseCnmt(cnmtBytes);
        const bool firmwareTooOld = cnmt.hasRequiredSystemVersion &&
            firmwareTooNew(cnmt.requiredSystemVersion, currentFirmwarePacked());
        if (firmwareTooOld && !firmwareWarned) {
            firmwareWarned = true;
            const uint32_t v = cnmt.requiredSystemVersion;
            const std::string needed = std::to_string((v >> 26) & 0x3f) + "." + std::to_string((v >> 20) & 0x3f) +
                "." + std::to_string((v >> 16) & 0xf);
            if (opt_.clearFirmwareRequirement) {
                warn("Needs firmware " + needed + ". Clearing the requirement so HOME will launch it.");
            } else {
                warn("Needs firmware " + needed + " or newer to launch.");
            }
        }

        uint64_t remaining = 0;
        for (const auto& rec : cnmt.contents) {
            if (rec.type == uint8_t(CnmtContentType::DeltaFragment)) continue;
            if (rec.type == uint8_t(CnmtContentType::Meta)) continue;
            NcmContentId cid{};
            std::memcpy(cid.c, rec.ncaIdBytes, 16);
            bool already = false;
            ncmContentStorageHas(&cs, &already, &cid);
            if (!already) remaining += rec.size;
        }
        SpaceAvail chosen{};
        if (auto sp = storageSpace(storage == StorageTarget::Nand)) chosen = *sp;
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

            const NcmPlaceHolderId cph = rb.createPlaceholder(cid, ncaSize);
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
            rb.registerPlaceholder(cid, cph, "ncmContentStorageRegister");
        }

        clock.emit("commit", cnmt.titleId, 0, 1);
        auto blob = buildInstallContentMeta(cnmt, metaId.c, metaSize);
        if (firmwareTooOld && opt_.clearFirmwareRequirement && clearRequiredSystemVersion(cnmt.rawType, blob)) {
            brls::Logger::info("cleared required system version for {}", cnmt.titleId);
        }
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
        // From here a failure must also take the meta entry back out, or HOME shows a broken title.
        rb.metaKey = key;

        clock.emit("record", cnmt.applicationId, 0, 1);
        check(appRecordCommit(cnmt.applicationIdValue, ncmId(storage), key), "ns application record");
        rb.titleCommitted();
    }

    if (!any) throw InstallError("0x0", "container has no CNMT");
    clock.emit("record", job.name, job.size, job.size);
#endif
}

} // namespace nslib
