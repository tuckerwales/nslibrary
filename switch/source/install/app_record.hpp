#pragma once

#ifdef __SWITCH__
#include <switch.h>
#endif

#include <cstdint>
#include <optional>

namespace nslib {

#ifdef __SWITCH__

Result appRecordInit();
void appRecordExit();

/** Merge this meta into the ns application record and push it. For patches, also avmPushLaunchVersion. */
Result appRecordCommit(u64 applicationId, NcmStorageId storage, const NcmContentMetaKey& key);

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
