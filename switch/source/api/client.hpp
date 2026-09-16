#pragma once

#include "api/protocol.hpp"
#include "transport/ITransport.hpp"

#include <functional>
#include <stdexcept>
#include <string>

namespace nslib {

class ApiError : public std::runtime_error {
public:
    int status;
    std::string code;
    ApiError(int status, std::string code, const std::string& msg)
        : std::runtime_error(msg), status(status), code(std::move(code)) {}
};

class DeviceApiClient {
public:
    DeviceApiClient(ITransport& transport, std::string token);

    void setToken(std::string token) { token_ = std::move(token); }
    const std::string& token() const { return token_; }

    PairResponse pair(const PairRequest& req);
    HelloResponse hello();
    void putState(const DeviceState& state);
    CatalogResponse catalog(int64_t since = -1, const std::string& cursor = {}, int limit = 0);
    EventsResponse events(const std::string& cursor, int waitSeconds);
    Job createJob(int64_t contentMetaId, const std::string& target);
    Job claimJob(int64_t id);
    void progress(int64_t id, const JobProgress& p);
    void complete(int64_t id, const JobComplete& c);
    void getFile(int64_t fileId, uint64_t offset, uint64_t length,
        const std::function<void(const uint8_t*, size_t)>& sink);

    std::vector<CatalogApp> fetchFullCatalog();

private:
    ITransport& transport_;
    std::string token_;

    HttpResponse call(const std::string& method, const std::string& path, const std::string* body, bool auth,
        long timeoutMs = 30000);
    Json expectJson(const HttpResponse& res);
};

} // namespace nslib
