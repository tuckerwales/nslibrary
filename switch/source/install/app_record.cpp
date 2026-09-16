#include "install/app_record.hpp"

#ifdef __SWITCH__

#include "install/record_merge.hpp"

#include <cstring>
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
    // Keep the untouched key bytes (install_type, padding) for records we did not change.
    for (const auto& r : original) {
        if (r.key.id == m.id && r.key.version == m.version && r.key.type == m.type && r.storageId == m.storage) {
            return r;
        }
    }
    out.key = incoming;
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

Result appRecordCommit(u64 applicationId, NcmStorageId storage, const NcmContentMetaKey& key) {
    Result rc = appRecordInit();
    if (R_FAILED(rc)) return rc;

    std::vector<ContentStorageRecord> existing;
    rc = listRecords(applicationId, existing);
    if (R_FAILED(rc)) return rc;

    std::vector<MetaRecord> meta;
    meta.reserve(existing.size() + 1);
    for (const auto& r : existing) meta.push_back(toMeta(r));

    MetaRecord incoming;
    incoming.id = key.id;
    incoming.version = key.version;
    incoming.type = key.type;
    incoming.storage = u8(storage);
    const auto merged = mergeMetaRecord(std::move(meta), incoming);

    std::vector<ContentStorageRecord> records;
    records.reserve(merged.size());
    for (const auto& m : merged) records.push_back(fromMeta(m, existing, key));

    if (!existing.empty()) {
        rc = deleteRecord(applicationId);
        if (R_FAILED(rc)) return rc;
    }

    rc = pushRecords(applicationId, records.data(), u32(records.size()));
    if (R_FAILED(rc)) {
        // Put the previous records back so a failed push does not hide the game.
        if (!existing.empty()) pushRecords(applicationId, existing.data(), u32(existing.size()));
        return rc;
    }

    if (key.type == NcmContentMetaType_Patch || key.type == NcmContentMetaType_Application) {
        rc = avmInitialize();
        if (R_SUCCEEDED(rc)) {
            avmPushLaunchVersion(applicationId, launchVersionFor(merged));
            avmExit();
        }
    }
    return 0;
}

} // namespace nslib

#endif
