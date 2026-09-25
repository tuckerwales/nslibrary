#include "installed/manage.hpp"

#ifdef __SWITCH__

#include "app/services.hpp"
#include "formats/meta.hpp"
#include "install/app_record.hpp"
#include "install/engine.hpp"
#include "install/placeholder_journal.hpp"
#include "installed/compare.hpp"
#include "ui/format.hpp"

#include <borealis.hpp>
#include <switch.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <optional>
#include <vector>

namespace nslib {
namespace {

/** Copy chunk. Small enough for applet mode's heap, big enough that IPC overhead doesn't matter. */
constexpr size_t kCopyChunk = 1024 * 1024;

std::string resultHex(Result rc) {
    char buf[16];
    std::snprintf(buf, sizeof(buf), "0x%X", rc);
    return buf;
}

void check(Result rc, const std::string& what) {
    if (R_FAILED(rc)) throw InstallError(resultHex(rc), what + " failed (" + resultHex(rc) + ")");
}

NcmStorageId storageId(const std::string& storage) {
    return storage == "nand" ? NcmStorageId_BuiltInUser : NcmStorageId_SdCard;
}

const char* storageLabel(NcmStorageId storage) {
    return storage == NcmStorageId_BuiltInUser ? "system memory" : "the SD card";
}

u64 parseId(const std::string& hex) { return std::strtoull(hex.c_str(), nullptr, 16); }

std::string hexId(u64 id) {
    char buf[17];
    std::snprintf(buf, sizeof(buf), "%016llX", static_cast<unsigned long long>(id));
    return buf;
}

NcmContentMetaKey keyFor(const InstalledTitle& row) {
    NcmContentMetaKey key{};
    key.id = parseId(row.titleId);
    key.version = row.version;
    if (row.type == "patch") key.type = NcmContentMetaType_Patch;
    else if (row.type == "addon" || row.type == "aoc") key.type = NcmContentMetaType_AddOnContent;
    else key.type = NcmContentMetaType_Application;
    key.install_type = NcmContentInstallType_Full;
    return key;
}

struct Meta {
    NcmContentMetaKey key;
    NcmStorageId storage;
};

bool sameMeta(const Meta& a, const Meta& b) {
    return a.key.id == b.key.id && a.key.version == b.key.version && a.key.type == b.key.type &&
        a.storage == b.storage;
}

class MetaDb {
public:
    explicit MetaDb(NcmStorageId storage) { rc_ = ncmOpenContentMetaDatabase(&db_, storage); }
    ~MetaDb() {
        if (R_SUCCEEDED(rc_)) ncmContentMetaDatabaseClose(&db_);
    }
    MetaDb(const MetaDb&) = delete;
    MetaDb& operator=(const MetaDb&) = delete;
    Result rc() const { return rc_; }
    NcmContentMetaDatabase* get() { return &db_; }

private:
    NcmContentMetaDatabase db_{};
    Result rc_ = 0;
};

class ContentStore {
public:
    explicit ContentStore(NcmStorageId storage) { rc_ = ncmOpenContentStorage(&cs_, storage); }
    ~ContentStore() {
        if (R_SUCCEEDED(rc_)) ncmContentStorageClose(&cs_);
    }
    ContentStore(const ContentStore&) = delete;
    ContentStore& operator=(const ContentStore&) = delete;
    Result rc() const { return rc_; }
    NcmContentStorage* get() { return &cs_; }

    bool has(const ContentInfo& info) {
        bool out = false;
        NcmContentId id{};
        std::memcpy(id.c, info.contentId, 16);
        return R_SUCCEEDED(ncmContentStorageHas(&cs_, &out, &id)) && out;
    }

private:
    NcmContentStorage cs_{};
    Result rc_ = 0;
};

NcmContentId contentId(const ContentInfo& info) {
    NcmContentId id{};
    std::memcpy(id.c, info.contentId, 16);
    return id;
}

/** The stored meta blob for `m`, or an empty one when the database doesn't have it. */
std::vector<u8> readMeta(const Meta& m) {
    MetaDb db(m.storage);
    if (R_FAILED(db.rc())) return {};
    u64 size = 0;
    if (R_FAILED(ncmContentMetaDatabaseGetSize(db.get(), &size, &m.key)) || size == 0) return {};
    std::vector<u8> blob(size_t(size), 0);
    u64 read = 0;
    if (R_FAILED(ncmContentMetaDatabaseGet(db.get(), &m.key, &read, blob.data(), size))) return {};
    blob.resize(size_t(read));
    return blob;
}

/** The game `row` belongs to. Updates and DLC say so in their stored meta; the title ID is the fallback. */
u64 applicationIdOf(const InstalledTitle& row) {
    const Meta own{keyFor(row), storageId(row.storage)};
    if (const auto id = storedApplicationId(own.key.type, readMeta(own))) return *id;
    return parseId(applicationIdFor(row));
}

/** The titles an action on `row` covers: a game brings everything HOME records for it. */
std::vector<Meta> metasFor(const InstalledTitle& row, u64 applicationId) {
    const Meta own{keyFor(row), storageId(row.storage)};
    std::vector<Meta> out;
    if (own.key.type == NcmContentMetaType_Application) {
        std::vector<RecordedMeta> recorded;
        if (R_SUCCEEDED(appRecordList(applicationId, recorded))) {
            for (const auto& r : recorded) out.push_back({r.key, r.storage});
        }
    }
    bool listed = false;
    for (const auto& m : out) listed = listed || sameMeta(m, own);
    if (!listed) out.insert(out.begin(), own);
    return out;
}

/**
 * Take `m` out of its content meta database, then delete its NCAs. Keeps going past a failure so as
 * little as possible is left behind, and returns the first one.
 */
Result deleteMeta(const Meta& m) {
    const auto infos = storedContentInfos(readMeta(m));
    Result first = 0;
    {
        MetaDb db(m.storage);
        Result rc = db.rc();
        if (R_SUCCEEDED(rc)) rc = ncmContentMetaDatabaseRemove(db.get(), &m.key);
        if (R_SUCCEEDED(rc)) rc = ncmContentMetaDatabaseCommit(db.get());
        if (R_FAILED(rc)) first = rc;
    }
    ContentStore cs(m.storage);
    if (R_FAILED(cs.rc())) return R_FAILED(first) ? first : cs.rc();
    for (const auto& info : infos) {
        if (!cs.has(info)) continue;
        const NcmContentId id = contentId(info);
        const Result rc = ncmContentStorageDelete(cs.get(), &id);
        if (R_FAILED(rc) && R_SUCCEEDED(first)) first = rc;
    }
    brls::Logger::info("removed {:016X} v{} from storage {} rc=0x{:X}", m.key.id, m.key.version, int(m.storage), first);
    return first;
}

bool metaExists(const Meta& m) {
    MetaDb db(m.storage);
    bool has = false;
    return R_SUCCEEDED(db.rc()) && R_SUCCEEDED(ncmContentMetaDatabaseHas(db.get(), &has, &m.key)) && has;
}

/** Keep the console awake and in NSLibrary while content is half copied. */
struct BusyGuard {
    bool titleOverride = false;
    BusyGuard() {
        appletSetMediaPlaybackState(true);
        titleOverride = !isAppletMode();
        if (titleOverride) {
            appletSetAutoSleepDisabled(true);
            appletBeginBlockingHomeButton(0);
        }
    }
    ~BusyGuard() {
        if (titleOverride) {
            appletEndBlockingHomeButton();
            appletSetAutoSleepDisabled(false);
        }
        appletSetMediaPlaybackState(false);
    }
};

JournalEntry journalEntry(NcmStorageId storage, const NcmPlaceHolderId& ph) {
    JournalEntry e;
    e.storage = uint8_t(storage);
    std::memcpy(e.id.data(), ph.uuid.uuid, 16);
    return e;
}

/** Undoes a half-copied title on the destination. Disarmed once HOME points at the copy. */
struct CopyRollback {
    NcmContentStorage* cs;
    NcmStorageId storage;
    PlaceholderJournal journal{kPlaceholderJournalPath};
    std::vector<NcmPlaceHolderId> placeholders;
    std::vector<NcmContentId> registered;
    std::optional<NcmContentMetaKey> metaKey;

    CopyRollback(NcmContentStorage* cs, NcmStorageId storage) : cs(cs), storage(storage) {}

    void dropJournal(const NcmPlaceHolderId& ph) {
        try {
            journal.remove(journalEntry(storage, ph));
        } catch (...) {
        }
    }

    void committed() {
        placeholders.clear();
        registered.clear();
        metaKey.reset();
    }

    ~CopyRollback() {
        for (auto& ph : placeholders) {
            ncmContentStorageDeletePlaceHolder(cs, &ph);
            dropJournal(ph);
        }
        for (auto& id : registered) ncmContentStorageDelete(cs, &id);
        if (metaKey) {
            MetaDb db(storage);
            if (R_SUCCEEDED(db.rc()) && R_SUCCEEDED(ncmContentMetaDatabaseRemove(db.get(), &*metaKey))) {
                ncmContentMetaDatabaseCommit(db.get());
            }
        }
    }
};

struct PlannedMove {
    Meta from;
    std::vector<u8> blob;
    std::vector<ContentInfo> infos;
    /** Parallel to `infos`: false for content the destination already has. */
    std::vector<bool> copy;
    uint64_t bytes = 0;
};

std::vector<PlannedMove> planMove(const InstalledTitle& row, NcmStorageId to) {
    std::vector<PlannedMove> out;
    ContentStore dst(to);
    check(dst.rc(), std::string("Opening ") + storageLabel(to));
    for (const auto& m : metasFor(row, applicationIdOf(row))) {
        if (m.storage == to) continue;
        PlannedMove p;
        p.from = m;
        p.blob = readMeta(m);
        p.infos = storedContentInfos(p.blob);
        if (p.infos.empty()) {
            throw InstallError("0x0", "Could not read the content list of " + hexId(m.key.id));
        }
        for (const auto& info : p.infos) {
            const bool needed = !dst.has(info);
            p.copy.push_back(needed);
            if (needed) p.bytes += contentInfoSize(info);
        }
        out.push_back(std::move(p));
    }
    return out;
}

void copyContent(NcmContentStorage* src, CopyRollback& rb, const ContentInfo& info, std::vector<u8>& buffer,
    uint64_t& done, uint64_t total, const MoveProgress& progress, std::atomic<bool>* cancel)
{
    const NcmContentId id = contentId(info);
    const uint64_t size = contentInfoSize(info);
    NcmPlaceHolderId ph{};
    check(ncmContentStorageGeneratePlaceHolderId(rb.cs, &ph), "ncmContentStorageGeneratePlaceHolderId");
    try {
        rb.journal.add(journalEntry(rb.storage, ph));
    } catch (const std::exception& e) {
        brls::Logger::warning("placeholder journal: {}", e.what());
    }
    rb.placeholders.push_back(ph);
    check(ncmContentStorageCreatePlaceHolder(rb.cs, &id, &ph, s64(size)), "ncmContentStorageCreatePlaceHolder");

    for (uint64_t offset = 0; offset < size;) {
        if (cancel && *cancel) throw InstallError("cancelled", "cancelled");
        const size_t n = size_t(std::min<uint64_t>(buffer.size(), size - offset));
        check(ncmContentStorageReadContentIdFile(src, buffer.data(), n, &id, s64(offset)),
            "ncmContentStorageReadContentIdFile");
        check(ncmContentStorageWritePlaceHolder(rb.cs, &ph, offset, buffer.data(), n),
            "ncmContentStorageWritePlaceHolder");
        offset += n;
        done += n;
        if (progress) progress(done, total);
    }

    check(ncmContentStorageFlushPlaceHolder(rb.cs), "ncmContentStorageFlushPlaceHolder");
    check(ncmContentStorageRegister(rb.cs, &id, &ph), "ncmContentStorageRegister");
    rb.placeholders.pop_back();
    rb.dropJournal(ph);
    rb.registered.push_back(id);
}

} // namespace

bool runningInPlaceOf(const InstalledTitle& row) {
    if (isAppletMode()) return false;
    u64 programId = 0;
    if (R_FAILED(svcGetInfo(&programId, InfoType_ProgramId, CUR_PROCESS_HANDLE, 0))) return false;
    return programId == applicationIdOf(row);
}

TitleFootprint measureTitle(const InstalledTitle& row, const std::string& moveTo) {
    TitleFootprint out;
    const auto metas = metasFor(row, applicationIdOf(row));
    std::optional<ContentStore> dst;
    if (!moveTo.empty()) dst.emplace(storageId(moveTo));
    const bool canCheckDst = dst && R_SUCCEEDED(dst->rc());
    for (const auto& m : metas) {
        out.titles++;
        for (const auto& info : storedContentInfos(readMeta(m))) {
            const uint64_t size = contentInfoSize(info);
            out.bytes += size;
            if (dst && m.storage != storageId(moveTo) && !(canCheckDst && dst->has(info))) out.toCopy += size;
        }
    }
    return out;
}

void uninstallTitle(const InstalledTitle& row) {
    const Meta own{keyFor(row), storageId(row.storage)};
    const u64 applicationId = applicationIdOf(row);
    brls::Logger::info("uninstall {:016X} v{} ({}) app {:016X}", own.key.id, own.key.version, row.type, applicationId);

    if (own.key.type == NcmContentMetaType_Application) {
        std::vector<RecordedMeta> recorded;
        appRecordList(applicationId, recorded);
        if (!recorded.empty()) {
            check(nsDeleteApplicationCompletely(applicationId), "nsDeleteApplicationCompletely");
            // ns removes what the record lists. A copy the record forgot about would linger.
            if (metaExists(own)) check(deleteMeta(own), "Removing leftover content");
            return;
        }
        // HOME doesn't list the game, so there is no record to update: only content to remove.
        check(deleteMeta(own), "Removing content");
        return;
    }

    // Record first, so HOME never points at content that is already gone.
    check(appRecordRemove(applicationId, own.key, own.storage), "Updating the HOME record");
    check(deleteMeta(own), "Removing content");
}

void moveTitle(const InstalledTitle& row, const std::string& to, const MoveProgress& progress,
    std::atomic<bool>* cancel)
{
    const NcmStorageId dstId = storageId(to);
    const u64 applicationId = applicationIdOf(row);
    auto plan = planMove(row, dstId);
    if (plan.empty()) return;

    uint64_t total = 0;
    for (const auto& p : plan) total += p.bytes;
    const auto space = storageSpace(dstId == NcmStorageId_BuiltInUser);
    if (!space) throw InstallError("0x0", std::string("Could not read the free space on ") + storageLabel(dstId));
    if (space->free < total) {
        throw InstallError("preflight", std::string("Not enough space on ") + storageLabel(dstId) + ": needs " +
                formatSize(total) + ", " + formatSize(space->free) + " free");
    }
    brls::Logger::info("move {:016X} ({} title(s), {} bytes) to {}", applicationId, plan.size(), total, to);

    BusyGuard guard;
    std::vector<u8> buffer(kCopyChunk);
    ContentStore dst(dstId);
    check(dst.rc(), std::string("Opening ") + storageLabel(dstId));
    uint64_t done = 0;
    if (progress) progress(0, total);

    for (auto& p : plan) {
        ContentStore src(p.from.storage);
        check(src.rc(), std::string("Opening ") + storageLabel(p.from.storage));
        {
            CopyRollback rb(dst.get(), dstId);
            for (size_t i = 0; i < p.infos.size(); i++) {
                if (p.copy[i]) copyContent(src.get(), rb, p.infos[i], buffer, done, total, progress, cancel);
            }
            if (cancel && *cancel) throw InstallError("cancelled", "cancelled");

            // An entry the destination already had is not ours to take back out.
            const bool hadEntry = metaExists({p.from.key, dstId});
            MetaDb db(dstId);
            check(db.rc(), "ncmOpenContentMetaDatabase");
            if (!hadEntry) rb.metaKey = p.from.key;
            Result rc = ncmContentMetaDatabaseSet(db.get(), &p.from.key, p.blob.data(), p.blob.size());
            if (R_SUCCEEDED(rc)) rc = ncmContentMetaDatabaseCommit(db.get());
            check(rc, "ncmContentMetaDatabaseSet");

            check(appRecordMove(applicationId, p.from.key, p.from.storage, dstId), "Updating the HOME record");
            rb.committed();
        }
        // HOME now uses the copy, so the original can go. If this fails the title is merely on both.
        const Result rc = deleteMeta(p.from);
        if (R_FAILED(rc)) {
            brls::Logger::warning("move: could not remove the original of {:016X} (0x{:X})", p.from.key.id, rc);
        }
    }
}

} // namespace nslib

#endif
