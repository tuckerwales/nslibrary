#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace nslib {

/** HTTPS GET of a full URL (GitHub). Follows redirects. TLS is not trusted; signatures are. */
std::string httpGetString(const std::string& url, long timeoutMs = 30000);

void httpGetStream(
    const std::string& url, const std::function<void(const uint8_t*, size_t)>& sink, long timeoutMs = 120000);

std::vector<uint8_t> httpGetBytes(const std::string& url, long timeoutMs = 60000);

} // namespace nslib
