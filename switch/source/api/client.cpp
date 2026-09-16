#include "api/client.hpp"

#include "api/url.hpp"

#include <cstdint>
#include <sstream>
#include <stdexcept>

namespace nslib {

DeviceApiClient::DeviceApiClient(ITransport& transport, std::string token)
    : transport_(transport), token_(std::move(token)) {}

HttpResponse DeviceApiClient::call(const std::string& method, const std::string& path, const std::string* body,
    bool auth, long timeoutMs, long connectTimeoutMs)
{
    (void)auth;
    transport_.setTimeoutMs(timeoutMs);
    transport_.setConnectTimeoutMs(connectTimeoutMs);
    return transport_.request(method, path, body, {});
}

Json DeviceApiClient::expectJson(const HttpResponse& res) {
    Json v = Json::null();
    if (!res.body.empty()) {
        try {
            v = Json::parse(res.body);
        } catch (const JsonError& e) {
            throw ApiError(res.status, "INTERNAL", std::string("invalid JSON: ") + e.what());
        }
    }
    if (auto err = tryParseError(v)) {
        throw ApiError(res.status, err->code, err->msg);
    }
    if (res.status >= 400) {
        throw ApiError(res.status, "INTERNAL", "HTTP " + std::to_string(res.status));
    }
    return v;
}

PairResponse DeviceApiClient::pair(const PairRequest& req) {
    const std::string body = encodePairRequest(req).dump();
    const auto res = call("POST", "/pair", &body, false);
    return parsePairResponse(expectJson(res));
}

PairResponse DeviceApiClient::usbHello(const DeviceInfo& device) {
    const std::string body = encodeDeviceInfo(device).dump();
    const auto res = call("POST", "/usb/hello", &body, false);
    return parsePairResponse(expectJson(res));
}

HelloResponse DeviceApiClient::hello() {
    return parseHello(expectJson(call("GET", "/hello", nullptr, true)));
}

void DeviceApiClient::putState(const DeviceState& state) {
    const std::string body = encodeDeviceState(state).dump();
    const auto res = call("PUT", "/state", &body, true);
    if (res.status != 204 && res.status != 200) expectJson(res);
}

CatalogResponse DeviceApiClient::catalog(int64_t since, const std::string& cursor, int limit) {
    std::vector<std::pair<std::string, std::string>> q;
    if (since >= 0) q.emplace_back("since", std::to_string(since));
    if (!cursor.empty()) q.emplace_back("cursor", cursor);
    if (limit > 0) q.emplace_back("limit", std::to_string(limit));
    return parseCatalog(expectJson(call("GET", "/catalog" + queryString(q), nullptr, true)));
}

EventsResponse DeviceApiClient::events(const std::string& cursor, int waitSeconds) {
    std::vector<std::pair<std::string, std::string>> q;
    if (!cursor.empty()) q.emplace_back("cursor", cursor);
    q.emplace_back("wait", std::to_string(waitSeconds));
    const long timeout = (long(waitSeconds) + 10) * 1000;
    return parseEvents(expectJson(call("GET", "/events" + queryString(q), nullptr, true, timeout, kQuickConnectMs)));
}

Job DeviceApiClient::createJob(int64_t contentMetaId, const std::string& target) {
    const std::string body = encodeCreateJob(contentMetaId, target).dump();
    return parseJob(expectJson(call("POST", "/jobs", &body, true)));
}

Job DeviceApiClient::claimJob(int64_t id) {
    const auto res = expectJson(call("POST", "/jobs/" + std::to_string(id) + "/claim", nullptr, true));
    if (res.has("job")) return parseJob(res["job"]);
    return parseJob(res);
}

void DeviceApiClient::progress(int64_t id, const JobProgress& p) {
    const std::string body = encodeJobProgress(p).dump();
    const auto res = call("POST", "/jobs/" + std::to_string(id) + "/progress", &body, true, 5000, kQuickConnectMs);
    if (res.status != 204 && res.status != 200) expectJson(res);
}

void DeviceApiClient::complete(int64_t id, const JobComplete& c) {
    const std::string body = encodeJobComplete(c).dump();
    const auto res = call("POST", "/jobs/" + std::to_string(id) + "/complete", &body, true);
    if (res.status != 204 && res.status != 200) expectJson(res);
}

std::vector<uint8_t> DeviceApiClient::getIcon(const std::string& appId, std::optional<int64_t> rev) {
    std::string path = "/icons/" + appId;
    if (rev) path += "?v=" + std::to_string(*rev);
    const auto res = call("GET", path, nullptr, true, 15000, kQuickConnectMs);
    if (res.status != 200) {
        throw ApiError(res.status, "NOT_FOUND", "icon HTTP " + std::to_string(res.status));
    }
    return std::vector<uint8_t>(res.body.begin(), res.body.end());
}

void DeviceApiClient::throwStreamError(int status, const std::string& fallbackCode, const std::string& what) {
    const std::string body = transport_.lastStreamError();
    if (!body.empty()) {
        try {
            if (auto err = tryParseError(Json::parse(body))) throw ApiError(status, err->code, err->msg);
        } catch (const JsonError&) {
        }
    }
    throw ApiError(status, fallbackCode, what + " HTTP " + std::to_string(status));
}

int DeviceApiClient::getUpdate(const std::function<void(const uint8_t*, size_t)>& sink) {
    transport_.setTimeoutMs(30000);
    transport_.setConnectTimeoutMs(10000);
    const int status = transport_.stream("/update", 0, UINT64_MAX, {}, sink);
    if (status != 200 && status != 206) throwStreamError(status, "NOT_FOUND", "update");
    return status;
}

std::vector<uint8_t> DeviceApiClient::getSmallFile(const std::string& path, size_t maxBytes) {
    std::vector<uint8_t> out;
    transport_.setTimeoutMs(30000);
    transport_.setConnectTimeoutMs(10000);
    const int status = transport_.stream(path, 0, UINT64_MAX, {}, [&](const uint8_t* p, size_t n) {
        if (out.size() + n > maxBytes) throw std::runtime_error(path + " is too large");
        out.insert(out.end(), p, p + n);
    });
    if (status != 200 && status != 206) throwStreamError(status, "NOT_FOUND", path);
    return out;
}

std::vector<uint8_t> DeviceApiClient::getUpdateManifest() { return getSmallFile("/update/manifest", 64 * 1024); }

std::vector<uint8_t> DeviceApiClient::getUpdateSignature() { return getSmallFile("/update/signature", 1024); }

void DeviceApiClient::getFile(int64_t fileId, uint64_t offset, uint64_t length,
    const std::function<void(const uint8_t*, size_t)>& sink)
{
    const std::string path = "/files/" + std::to_string(fileId);
    transport_.setTimeoutMs(30000);
    transport_.setConnectTimeoutMs(10000);
    const int status = transport_.stream(path, offset, length, {}, sink);
    if (status != 200 && status != 206) {
        throwStreamError(status, status == 416 ? "RANGE_NOT_SATISFIABLE" : "INTERNAL", "file download");
    }
}

} // namespace nslib
