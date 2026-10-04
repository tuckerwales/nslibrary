#pragma once

#include "api/protocol.hpp"
#include "transport/ITransport.hpp"

#include <functional>
#include <optional>
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
    PairResponse usbHello(const DeviceInfo& device);
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
    std::vector<uint8_t> getIcon(const std::string& appId, std::optional<int64_t> rev = {});
    int getUpdate(const std::function<void(const uint8_t*, size_t)>& sink);
    /** Exact bytes of the server's `update.json` and `update.json.sig` (signature checks need them unmodified). */
    std::vector<uint8_t> getUpdateManifest();
    std::vector<uint8_t> getUpdateSignature();

    /** Save backups kept on the server; `app` empty for every game, `latest` for the newest of each save. */
    std::vector<SaveBackup> listSaves(const std::string& app, bool latest);
    /** Uploads a save archive of `length` bytes read from `body`. */
    SaveUploadResult uploadSave(const SaveUploadQuery& query, uint64_t length, const BodySource& body);
    /** Downloads a stored archive, resuming if the connection drops. */
    void downloadSave(int64_t id, uint64_t length, const std::function<void(const uint8_t*, size_t)>& sink);

    /** Connect timeout for quick background calls (events, icons, progress). */
    static constexpr long kQuickConnectMs = 3000;

private:
    ITransport& transport_;
    std::string token_;

    HttpResponse call(const std::string& method, const std::string& path, const std::string* body, bool auth,
        long timeoutMs = 30000, long connectTimeoutMs = 10000);
    std::vector<uint8_t> getSmallFile(const std::string& path, size_t maxBytes);
    [[noreturn]] void throwStreamError(int status, const std::string& fallbackCode, const std::string& what);
    Json expectJson(const HttpResponse& res);
};

} // namespace nslib
