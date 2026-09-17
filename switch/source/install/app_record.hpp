#pragma once

#ifdef __SWITCH__
#include <switch.h>
#endif

#include <cstdint>

namespace nslib {

#ifdef __SWITCH__

Result appRecordInit();
void appRecordExit();

/** Merge this meta into the ns application record and push it. For patches, also avmPushLaunchVersion. */
Result appRecordCommit(u64 applicationId, NcmStorageId storage, const NcmContentMetaKey& key);

/** The version HOME wants installed before it will launch the game. avm needs 6.0.0+. */
Result launchRequiredVersion(u64 applicationId, u32* version);

/**
 * Drop that requirement back to 0, like DBI's "Reset required version". Fixes HOME asking for an
 * update when the update was removed or the pushed version is higher than what is installed.
 */
Result resetLaunchVersion(u64 applicationId);

#endif

} // namespace nslib
