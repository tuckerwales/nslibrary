#pragma once

#ifdef __SWITCH__
#include <switch.h>

#include <cstddef>

namespace nslib {

Result esInitialize();
void esExit();

/** ES cmd 1: import a ticket plus its certificate chain. */
Result esImportTicket(const void* tik, size_t tikSize, const void* cert, size_t certSize);

} // namespace nslib

#endif
