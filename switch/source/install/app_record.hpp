#pragma once

#ifdef __SWITCH__
#include <switch.h>
#endif

#include <cstdint>
#include <optional>
#include <vector>

namespace nslib {

#ifdef __SWITCH__

Result appRecordInit();
void appRecordExit();

/** Merge this meta into the ns application record and push it. For patches, also avmPushLaunchVersion. */
Result appRecordCommit(u64 applicationId, NcmStorageId storage, const NcmContentMetaKey& key);

/** One content meta the ns application record lists for a game, and the storage it is on. */
struct RecordedMeta {
    NcmContentMetaKey key;
    NcmStorageId storage;
};

/** Everything HOME records for `applicationId`: the game, its update, its DLC. Empty when it has no record. */
Result appRecordList(u64 applicationId, std::vector<RecordedMeta>& out);

/**
 * Drop `key` on `storage` from the record, after an update or DLC is uninstalled. Removing an update
 * also lowers the launch version avm expects to what is left.
 */
Result appRecordRemove(u64 applicationId, const NcmContentMetaKey& key, NcmStorageId storage);

/** Point the record for `key` at `to` after its content moved there from `from`. */
Result appRecordMove(u64 applicationId, const NcmContentMetaKey& key, NcmStorageId from, NcmStorageId to);

struct RequiredVersions {
    /** Version avm wants installed before HOME launches the game (6.0.0+). */
    std::optional<u32> launch;
    /** Highest RequiredSystemVersion stored for the game and its update, in raw CNMT form. */
    std::optional<u32> system;
};

RequiredVersions readRequiredVersions(u64 applicationId);

/**
 * DBI's "Reset required version": zero RequiredSystemVersion in the content meta database for the
 * game and its update ("A system update is required"), and push a launch version of 0 to avm
 * (HOME asking for an update that was removed). A game built for newer firmware may still not boot.
 */
Result resetRequiredVersions(u64 applicationId);

#endif

} // namespace nslib
