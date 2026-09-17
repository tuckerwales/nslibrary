#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace nslib {

struct HttpResponse {
    int status = 0;
    std::string body;
    std::map<std::string, std::string> headers;

    std::string header(const std::string& key) const {
        auto it = headers.find(key);
        return it == headers.end() ? std::string() : it->second;
    }
};

class ITransport {
public:
    virtual ~ITransport() = default;
    virtual void setToken(std::string token) = 0;
    virtual void setTimeoutMs(long ms) = 0;
    /** How long to wait for the connection itself (TCP connect, TLS handshake, USB host ready). */
    virtual void setConnectTimeoutMs(long ms) { (void)ms; }
    virtual void abort() {}
    /**
     * Clear a pending abort. Only the owner of the next job calls this: a transport must not drop a
     * cancel on its own when a new request starts, or a cancel that lands between two Range GETs is
     * silently lost and the install keeps running.
     */
    virtual void clearAbort() {}
    /** Body of the last stream() answered with a non-2xx status (usually a JSON error). */
    virtual std::string lastStreamError() const { return {}; }
    virtual HttpResponse request(
        const std::string& method,
        const std::string& path,
        const std::string* jsonBody,
        const std::vector<std::pair<std::string, std::string>>& extraHeaders) = 0;
    virtual int stream(
        const std::string& path,
        uint64_t offset,
        uint64_t length,
        const std::vector<std::pair<std::string, std::string>>& extraHeaders,
        const std::function<void(const uint8_t*, size_t)>& sink) = 0;
};

} // namespace nslib
