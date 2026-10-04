#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <stdexcept>
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

/** Fills `dst` with up to `max` bytes of a request body and returns how many. */
using BodySource = std::function<size_t(uint8_t* dst, size_t max)>;

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
    /**
     * POSTs a binary body of exactly `length` bytes, pulled from `body` a piece at a time so it
     * never has to fit in memory. The response is read like `request`'s (usually JSON).
     */
    virtual HttpResponse upload(const std::string& path, const std::string& contentType, uint64_t length,
        const BodySource& body)
    {
        (void)path;
        (void)contentType;
        (void)length;
        (void)body;
        throw std::runtime_error("This connection cannot upload");
    }
};

} // namespace nslib
