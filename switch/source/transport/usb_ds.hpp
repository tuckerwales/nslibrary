#pragma once

#include <cstddef>
#include <cstdint>

namespace nslib {

/** Raw usbDs bulk endpoints (VID 057E / PID 3000) with cancellable timeouts. */
bool usbDsAvailable();
void usbDsStart();
void usbDsStop();
/** Read exactly `n` bytes or throw. `timeoutNs` is per USB transfer chunk. */
void usbDsReadAll(void* dst, size_t n, uint64_t timeoutNs);
void usbDsWriteAll(const void* src, size_t n, uint64_t timeoutNs);
void usbDsCancel();

} // namespace nslib
