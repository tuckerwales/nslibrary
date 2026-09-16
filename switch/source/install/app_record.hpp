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

#endif

} // namespace nslib
