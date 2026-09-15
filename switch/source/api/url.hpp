#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace nslib {

constexpr const char* kDeviceApiBasePath = "/api/device/v1";
constexpr const char* kDiscoveryQuery = "NSLIB?1";
constexpr uint16_t kDiscoveryPort = 8466;
constexpr int kDeviceApiProtocol = 1;
constexpr uint16_t kDefaultServerPort = 8465;

/** Trim, add http:// when missing, default port 8465 for http, strip trailing slash. */
std::string normalizeServerUrl(std::string url);

/** Join `http://host:port` with `/api/device/v1/hello` (or a query string). */
std::string joinUrl(const std::string& base, const std::string& pathAndQuery);

/** RFC 7233 `bytes=start-end` (inclusive). `length == UINT64_MAX` means open-ended. */
std::string rangeHeader(uint64_t start, uint64_t length);

/**
 * Percent-encode everything outside RFC 3986 unreserved characters. App IDs and event cursors come
 * from the server, so they are pasted into a URL only after this.
 */
std::string percentEncode(const std::string& value);

std::string queryString(const std::vector<std::pair<std::string, std::string>>& params);

} // namespace nslib
