#pragma once

#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>

namespace nslib {

using ByteSink = std::function<void(const uint8_t*, size_t)>;
using StreamAttempt = std::function<int(uint64_t offset, uint64_t length, const ByteSink& sink)>;
/** Called before retry `failures` (1-based). May sleep, and may throw to stop retrying. */
using RetryWait = std::function<void(int failures)>;

/** Thrown by a stream attempt for failures that retrying cannot fix (cancel, ignored Range). */
class StreamFatal : public std::runtime_error {
public:
    explicit StreamFatal(const std::string& msg) : std::runtime_error(msg) {}
};

/**
 * Issues ranged stream attempts until `length` bytes are delivered (or the source ends).
 * A throw is retried from the new offset. `maxAttempts` counts consecutive attempts that
 * delivered no bytes, so a long transfer survives any number of drops as long as it keeps
 * moving. Errors thrown by `sink` and StreamFatal are never retried.
 */
int streamResuming(uint64_t offset, uint64_t length, const ByteSink& sink, const StreamAttempt& attempt,
    int maxAttempts = 5, const RetryWait& wait = {});

/** Backoff before retry `failures` (1-based): 500 ms doubling, capped at 8 s. */
long retryDelayMs(int failures);

/** True when a 2xx `status` is a valid answer for a Range request at `offset`/`length`.
 *  Only an open-ended request from byte 0 may be answered with 200. */
bool rangeResponseOk(int status, uint64_t offset, uint64_t length);

int cmpVersion(const std::string& a, const std::string& b);

} // namespace nslib
