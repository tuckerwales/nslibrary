#pragma once

namespace nslib {

/** Latest run is truncated into this path on the SD card. */
const char* fileLogPath();

void fileLogInit();
void fileLogExit();

} // namespace nslib
