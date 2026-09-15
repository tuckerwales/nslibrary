#pragma once

#include <cstddef>
#include <cstdint>

namespace nslib {

/** Raw usbDs bulk endpoints (VID 057E / PID 3000) with cancellable timeouts. */
bool usbDsAvailable();
void usbDsStart();
void usbDsStop();
/** Read exactly `n` bytes or throw. `timeoutNs` is per USB transfer chunk; `readyTimeoutNs` bounds the
 *  wait for the host to configure the device (short, so an unplugged cable fails fast). */
void usbDsReadAll(void* dst, size_t n, uint64_t timeoutNs, uint64_t readyTimeoutNs);
void usbDsWriteAll(const void* src, size_t n, uint64_t timeoutNs, uint64_t readyTimeoutNs);
void usbDsCancel();

} // namespace nslib
