#include "installed/scanner.hpp"

#include "app/services.hpp"

#ifdef __SWITCH__
#include <switch.h>
#endif

#include <cstdio>
#include <vector>

namespace nslib {

#ifdef __SWITCH__

namespace {

const char* metaTypeName(u8 type) {
    switch (type) {
        case NcmContentMetaType_Application: return "application";
        case NcmContentMetaType_Patch: return "patch";
        case NcmContentMetaType_AddOnContent: return "addon";
        default: return "application";
    }
}

const char* storageName(NcmStorageId id) {
    return id == NcmStorageId_SdCard ? "sd" : "nand";
}

void listStorage(NcmStorageId storage, std::vector<InstalledTitle>& out) {
    NcmContentMetaDatabase db{};
    if (R_FAILED(ncmOpenContentMetaDatabase(&db, storage))) return;
    const NcmContentMetaType types[] = {
        NcmContentMetaType_Application,
        NcmContentMetaType_Patch,
        NcmContentMetaType_AddOnContent,
    };
    for (auto type : types) {
        s32 total = 0, written = 0;
        std::vector<NcmContentMetaKey> keys(64);
        Result rc = ncmContentMetaDatabaseList(&db, &total, &written, keys.data(), s32(keys.size()), type, 0, 0,
            UINT64_MAX, NcmContentInstallType_Full);
        if (R_SUCCEEDED(rc) && total > written) {
            keys.resize(size_t(total > 0 ? total : 0));
            rc = ncmContentMetaDatabaseList(&db, &total, &written, keys.data(), s32(keys.size()), type, 0, 0,
                UINT64_MAX, NcmContentInstallType_Full);
        }
        if (R_FAILED(rc)) continue;
        keys.resize(size_t(written > 0 ? written : 0));
        for (const auto& key : keys) {
            InstalledTitle t;
            char id[17];
            std::snprintf(id, sizeof(id), "%016llX", static_cast<unsigned long long>(key.id));
            t.titleId = id;
            t.version = key.version;
            t.type = metaTypeName(key.type);
            t.storage = storageName(storage);
            out.push_back(std::move(t));
        }
    }
    ncmContentMetaDatabaseClose(&db);
}

} // namespace

DeviceState scanInstalled() {
    DeviceState s;
    s.fw = firmwareVersion();
    s.ams = atmosphereVersion();
    s.sd = storageSpace(false);
    if (auto nand = storageSpace(true)) s.nand = *nand;
    listStorage(NcmStorageId_SdCard, s.titles);
    listStorage(NcmStorageId_BuiltInUser, s.titles);
    return s;
}

#else

DeviceState scanInstalled() {
    DeviceState s;
    s.fw = firmwareVersion();
    s.ams = atmosphereVersion();
    return s;
}

#endif

} // namespace nslib
