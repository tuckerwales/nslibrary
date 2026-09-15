#pragma once

namespace nslib {

/** Latest run is written to this path on the SD card. */
const char* fileLogPath();
/** The run before it, moved aside at startup. */
const char* previousFileLogPath();

void fileLogInit();
void fileLogExit();

} // namespace nslib
