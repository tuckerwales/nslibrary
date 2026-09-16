#pragma once

#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>

namespace nslib {

using ByteSink = std::function<void(const uint8_t*, size_t)>;
using StreamAttempt = std::function<int(uint64_t offset, uint64_t length, const ByteSink& sink)>;

/**
 * Issues ranged stream attempts until `length` bytes are delivered (or the source ends).
 * A throw with a partial write is retried from the new offset, up to `maxAttempts`.
 */
int streamResuming(uint64_t offset, uint64_t length, const ByteSink& sink, const StreamAttempt& attempt,
    int maxAttempts = 5);

int cmpVersion(const std::string& a, const std::string& b);

} // namespace nslib
