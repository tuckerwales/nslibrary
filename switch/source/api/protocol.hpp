#pragma once

#include "api/json.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace nslib {

struct ApiErrorBody {
    std::string code;
    std::string msg;
};

struct DeviceInfo {
    std::string deviceUuid;
    std::string name;
    std::string fw;
    std::string amsVersion;
    std::string appVersion;
};

struct PairRequest {
    DeviceInfo device;
    std::string code;
};

struct PairResponse {
    std::string token;
    int64_t deviceId = 0;
    std::string serverId;
    std::string serverName;
};

struct HelloResponse {
    std::string serverId;
    std::string serverName;
    int proto = 0;
    int64_t catalogRev = 0;
    std::vector<std::string> caps;
};

struct SpacePair {
    uint64_t free = 0;
    uint64_t total = 0;
};

struct InstalledTitle {
    std::string titleId;
    uint32_t version = 0;
    std::string type;
    std::string storage;
};

struct DeviceState {
    std::string fw;
    std::string ams;
    std::optional<SpacePair> sd;
    SpacePair nand;
    std::vector<InstalledTitle> titles;
};

struct CatalogContentRef {
    uint32_t version = 0;
    int64_t contentMetaId = 0;
    uint64_t size = 0;
    std::string format;
};

struct CatalogAddon {
    std::string titleId;
    uint32_t version = 0;
    std::string name;
    int64_t contentMetaId = 0;
    uint64_t size = 0;
};

struct CatalogApp {
    std::string id;
    std::string name;
    std::string publisher;
    std::optional<int64_t> iconRev;
    std::optional<uint32_t> requiredSysVersion;
    std::optional<CatalogContentRef> base;
    std::vector<CatalogContentRef> updates;
    std::vector<CatalogAddon> dlc;
};

struct CatalogResponse {
    int64_t rev = 0;
    bool full = false;
    std::vector<CatalogApp> apps;
    std::vector<std::string> del;
    std::optional<std::string> next;
};

struct Job {
    int64_t id = 0;
    int64_t contentMetaId = 0;
    int64_t fileId = 0;
    std::string titleId;
    uint32_t version = 0;
    std::string type;
    std::string name;
    uint64_t size = 0;
    std::string format;
    std::string target;
    std::string status;
};

struct DeviceEvent {
    std::string t;
    std::optional<Job> job;
    int64_t id = 0;
    int64_t rev = 0;
};

struct EventsResponse {
    std::string cursor;
    std::vector<DeviceEvent> ev;
};

struct JobProgress {
    std::string phase;
    std::optional<std::string> item;
    uint64_t done = 0;
    uint64_t total = 0;
    double bps = 0;
};

struct JobComplete {
    bool ok = false;
    std::optional<std::string> result;
    std::optional<std::string> msg;
};

struct DiscoveryReply {
    std::string serverId;
    std::string name;
    int port = 0;
    int proto = 0;
};

std::optional<ApiErrorBody> tryParseError(const Json& v);
ApiErrorBody parseError(const Json& v);

PairRequest parsePairRequest(const Json& v);
PairResponse parsePairResponse(const Json& v);
HelloResponse parseHello(const Json& v);
DeviceState parseDeviceState(const Json& v);
CatalogResponse parseCatalog(const Json& v);
Job parseJob(const Json& v);
EventsResponse parseEvents(const Json& v);
JobProgress parseJobProgress(const Json& v);
DiscoveryReply parseDiscoveryReply(const Json& v);

Json encodePairRequest(const PairRequest& r);
Json encodeDeviceState(const DeviceState& s);
Json encodeJobProgress(const JobProgress& p);
Json encodeJobComplete(const JobComplete& c);
Json encodeCreateJob(int64_t contentMetaId, const std::string& target);

inline PairResponse parsePairResponse(const std::string& text) { return parsePairResponse(Json::parse(text)); }
inline HelloResponse parseHello(const std::string& text) { return parseHello(Json::parse(text)); }
inline DeviceState parseDeviceState(const std::string& text) { return parseDeviceState(Json::parse(text)); }
inline CatalogResponse parseCatalog(const std::string& text) { return parseCatalog(Json::parse(text)); }
inline EventsResponse parseEvents(const std::string& text) { return parseEvents(Json::parse(text)); }
inline JobProgress parseJobProgress(const std::string& text) { return parseJobProgress(Json::parse(text)); }
inline DiscoveryReply parseDiscoveryReply(const std::string& text) { return parseDiscoveryReply(Json::parse(text)); }
inline PairRequest parsePairRequest(const std::string& text) { return parsePairRequest(Json::parse(text)); }

} // namespace nslib
