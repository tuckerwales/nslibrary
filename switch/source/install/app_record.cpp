#include "install/app_record.hpp"

#ifdef __SWITCH__

#include "formats/meta.hpp"
#include "install/record_merge.hpp"

#include <algorithm>
#include <borealis.hpp>
#include <cstring>
#include <functional>
#include <vector>

namespace nslib {
namespace {

constexpr u8 kRecordInstalled = 0x3;

struct ContentStorageRecord {
    NcmContentMetaKey key;
    u8 storageId;
    u8 padding[7];
};

Service g_nsApp{};
bool g_open = false;

Result listRecords(u64 applicationId, std::vector<ContentStorageRecord>& out) {
    s32 count = 0;
    Result rc = nsCountApplicationContentMeta(applicationId, &count);
    if (R_FAILED(rc)) {
        out.clear();
        return 0;
    }
    if (count <= 0) return 0;
    out.resize(size_t(count));
    const struct {
        u64 offset;
        u64 tid;
    } in = {0, applicationId};
    s32 read = 0;
    rc = serviceDispatchInOut(&g_nsApp, 17, in, read,
        .buffer_attrs = {SfBufferAttr_HipcMapAlias | SfBufferAttr_Out},
        .buffers = {{out.data(), out.size() * sizeof(ContentStorageRecord)}});
    if (R_SUCCEEDED(rc)) out.resize(size_t(read > 0 ? read : 0));
    return rc;
}

Result pushRecords(u64 applicationId, const ContentStorageRecord* records, u32 count) {
    const struct {
        u8 lastModifiedEvent;
        u8 padding[7];
        u64 tid;
    } in = {kRecordInstalled, {0}, applicationId};
    return serviceDispatchIn(&g_nsApp, 16, in,
        .buffer_attrs = {SfBufferAttr_HipcMapAlias | SfBufferAttr_In},
        .buffers = {{records, count * sizeof(*records)}});
}

Result deleteRecord(u64 applicationId) {
    return serviceDispatchIn(&g_nsApp, 27, applicationId);
}

MetaRecord toMeta(const ContentStorageRecord& r) {
    MetaRecord m;
    m.id = r.key.id;
    m.version = r.key.version;
    m.type = r.key.type;
    m.storage = r.storageId;
    return m;
}

ContentStorageRecord fromMeta(const MetaRecord& m, const std::vector<ContentStorageRecord>& original,
    const NcmContentMetaKey& incoming)
{
    ContentStorageRecord out{};
    // Keep the untouched key bytes (install_type, padding) for records we did not change, and for
    // one that only moved storage.
    const auto sameKey = [&](const ContentStorageRecord& r) {
        return r.key.id == m.id && r.key.version == m.version && r.key.type == m.type;
    };
    for (const auto& r : original) {
        if (sameKey(r) && r.storageId == m.storage) return r;
    }
    out.key = incoming;
    for (const auto& r : original) {
        if (sameKey(r)) out.key = r.key;
    }
    out.storageId = m.storage;
    return out;
}

} // namespace

Result appRecordInit() {
    if (g_open) return 0;
    if (hosversionAtLeast(3, 0, 0)) {
        Result rc = nsGetApplicationManagerInterface(&g_nsApp);
        if (R_FAILED(rc)) return rc;
    } else {
        g_nsApp = *nsGetServiceSession_ApplicationManagerInterface();
    }
    g_open = true;
    return 0;
}

void appRecordExit() {
    if (g_open && hosversionAtLeast(3, 0, 0)) serviceClose(&g_nsApp);
    g_open = false;
}

namespace {

/**
 * Replace the record for `applicationId` with `change` applied to it. Records the change leaves
 * alone keep their original key bytes; a changed one takes `key`. On failure the old record is put
 * back so a game is never left without one.
 */
Result rewriteRecords(u64 applicationId, const NcmContentMetaKey& key,
    const std::function<std::vector<MetaRecord>(std::vector<MetaRecord>)>& change, std::vector<MetaRecord>* result)
{
    Result rc = appRecordInit();
    if (R_FAILED(rc)) return rc;

    std::vector<ContentStorageRecord> existing;
    rc = listRecords(applicationId, existing);
    if (R_FAILED(rc)) return rc;

    std::vector<MetaRecord> meta;
    meta.reserve(existing.size() + 1);
    for (const auto& r : existing) meta.push_back(toMeta(r));
    const auto changed = change(std::move(meta));

    std::vector<ContentStorageRecord> records;
    records.reserve(changed.size());
    for (const auto& m : changed) records.push_back(fromMeta(m, existing, key));

    if (!existing.empty()) {
        rc = deleteRecord(applicationId);
        if (R_FAILED(rc)) return rc;
    }

    if (!records.empty()) {
        rc = pushRecords(applicationId, records.data(), u32(records.size()));
        if (R_FAILED(rc)) {
            // Put the previous records back so a failed push does not hide the game.
            if (!existing.empty()) pushRecords(applicationId, existing.data(), u32(existing.size()));
            return rc;
        }
    }
    if (result) *result = changed;
    return 0;
}

void pushLaunchVersion(u64 applicationId, const std::vector<MetaRecord>& records) {
    if (R_SUCCEEDED(avmInitialize())) {
        avmPushLaunchVersion(applicationId, launchVersionFor(records));
        avmExit();
    }
}

} // namespace

Result appRecordCommit(u64 applicationId, NcmStorageId storage, const NcmContentMetaKey& key) {
    MetaRecord incoming;
    incoming.id = key.id;
    incoming.version = key.version;
    incoming.type = key.type;
    incoming.storage = u8(storage);
    std::vector<MetaRecord> merged;
    const Result rc = rewriteRecords(applicationId, key,
        [&](std::vector<MetaRecord> records) { return mergeMetaRecord(std::move(records), incoming); }, &merged);
    if (R_FAILED(rc)) return rc;

    if (key.type == NcmContentMetaType_Patch || key.type == NcmContentMetaType_Application) {
        pushLaunchVersion(applicationId, merged);
    }
    return 0;
}

Result appRecordList(u64 applicationId, std::vector<RecordedMeta>& out) {
    out.clear();
    Result rc = appRecordInit();
    if (R_FAILED(rc)) return rc;
    std::vector<ContentStorageRecord> records;
    rc = listRecords(applicationId, records);
    if (R_FAILED(rc)) return rc;
    for (const auto& r : records) out.push_back({r.key, NcmStorageId(r.storageId)});
    return 0;
}

Result appRecordRemove(u64 applicationId, const NcmContentMetaKey& key, NcmStorageId storage) {
    std::vector<MetaRecord> left;
    const Result rc = rewriteRecords(applicationId, key,
        [&](std::vector<MetaRecord> records) { return removeMetaRecord(std::move(records), key.id, u8(storage)); },
        &left);
    if (R_FAILED(rc)) return rc;
    // HOME would otherwise keep asking for the update that was just removed.
    if (key.type == NcmContentMetaType_Patch) pushLaunchVersion(applicationId, left);
    return 0;
}

Result appRecordMove(u64 applicationId, const NcmContentMetaKey& key, NcmStorageId from, NcmStorageId to) {
    return rewriteRecords(applicationId, key,
        [&](std::vector<MetaRecord> records) {
            return moveMetaRecord(std::move(records), key.id, u8(from), u8(to));
        },
        nullptr);
}

namespace {

bool hasSystemVersion(const ContentStorageRecord& r) {
    return r.key.type == NcmContentMetaType_Application || r.key.type == NcmContentMetaType_Patch;
}

Result readStoredMeta(NcmContentMetaDatabase& db, const NcmContentMetaKey& key, std::vector<u8>& out) {
    u64 size = 0;
    Result rc = ncmContentMetaDatabaseGetSize(&db, &size, &key);
    if (R_FAILED(rc)) return rc;
    out.resize(size_t(size));
    u64 read = 0;
    rc = ncmContentMetaDatabaseGet(&db, &key, &read, out.data(), size);
    if (R_SUCCEEDED(rc)) out.resize(size_t(read));
    return rc;
}

} // namespace

RequiredVersions readRequiredVersions(u64 applicationId) {
    RequiredVersions out;
    if (hosversionAtLeast(6, 0, 0) && R_SUCCEEDED(avmInitialize())) {
        u32 launch = 0;
        if (R_SUCCEEDED(avmGetLaunchRequiredVersion(applicationId, &launch))) out.launch = launch;
        avmExit();
    }

    std::vector<ContentStorageRecord> records;
    if (R_FAILED(appRecordInit()) || R_FAILED(listRecords(applicationId, records))) return out;
    for (const auto& r : records) {
        if (!hasSystemVersion(r)) continue;
        NcmContentMetaDatabase db;
        if (R_FAILED(ncmOpenContentMetaDatabase(&db, NcmStorageId(r.storageId)))) continue;
        std::vector<u8> blob;
        if (R_SUCCEEDED(readStoredMeta(db, r.key, blob))) {
            if (const auto v = storedRequiredSystemVersion(r.key.type, blob)) {
                out.system = std::max(out.system.value_or(0), *v);
            }
        }
        ncmContentMetaDatabaseClose(&db);
    }
    return out;
}

Result resetRequiredVersions(u64 applicationId) {
    Result rc = appRecordInit();
    if (R_FAILED(rc)) return rc;
    std::vector<ContentStorageRecord> records;
    rc = listRecords(applicationId, records);
    if (R_FAILED(rc)) return rc;

    // Keep going past a failure so one bad entry does not leave the rest untouched.
    Result first = 0;
    for (const auto& r : records) {
        if (!hasSystemVersion(r)) continue;
        NcmContentMetaDatabase db;
        rc = ncmOpenContentMetaDatabase(&db, NcmStorageId(r.storageId));
        if (R_FAILED(rc)) {
            if (R_SUCCEEDED(first)) first = rc;
            continue;
        }
        std::vector<u8> blob;
        rc = readStoredMeta(db, r.key, blob);
        if (R_SUCCEEDED(rc) && clearRequiredSystemVersion(r.key.type, blob)) {
            rc = ncmContentMetaDatabaseSet(&db, &r.key, blob.data(), blob.size());
            if (R_SUCCEEDED(rc)) rc = ncmContentMetaDatabaseCommit(&db);
        }
        ncmContentMetaDatabaseClose(&db);
        brls::Logger::info("reset required system version {:016X} v{} storage {} rc=0x{:X}", r.key.id,
            r.key.version, r.storageId, rc);
        if (R_FAILED(rc) && R_SUCCEEDED(first)) first = rc;
    }

    if (hosversionAtLeast(6, 0, 0)) {
        rc = avmInitialize();
        if (R_SUCCEEDED(rc)) {
            rc = avmPushLaunchVersion(applicationId, 0);
            avmExit();
        }
        brls::Logger::info("reset launch version {:016X} rc=0x{:X}", applicationId, rc);
        if (R_FAILED(rc) && R_SUCCEEDED(first)) first = rc;
    }
    return first;
}

} // namespace nslib

#endif
