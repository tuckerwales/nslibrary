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
    std::optional<std::string> appLatest;
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
    /** When the game was added to the library, in epoch seconds. Absent from older servers. */
    std::optional<int64_t> addedAt;
};

struct CatalogResponse {
    int64_t rev = 0;
    bool full = false;
    std::vector<CatalogApp> apps;
    std::vector<std::string> del;
    std::optional<std::string> next;
    /** Entries the server sent that this client could not read. Logged, never fatal. */
    size_t skipped = 0;
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

/** A save backup stored on the server (`GET /saves`). */
struct SaveBackup {
    int64_t id = 0;
    std::string app;
    /** "account" or "device". */
    std::string type;
    /** Account UID as 32 hex digits; empty for device saves. */
    std::string user;
    std::string userName;
    /** Name of the console that made it. */
    std::string device;
    /** True when this console made it. */
    bool mine = false;
    uint64_t size = 0;
    uint64_t dataSize = 0;
    uint32_t files = 0;
    std::string sha256;
    /** Epoch seconds. */
    int64_t at = 0;
    /** "manual", "auto" or "pre-restore". */
    std::string origin;
    bool pinned = false;
    std::string note;
};

struct SaveUploadResult {
    SaveBackup backup;
    /** The server already had these exact bytes as the newest backup of this save. */
    bool dup = false;
};

/** What `POST /saves` needs to know about an archive besides its bytes. */
struct SaveUploadQuery {
    std::string app;
    std::string type;
    std::string user;
    std::string userName;
    std::string name;
    std::string origin = "manual";
    std::string sha256;
};

struct DiscoveryReply {
    std::string serverId;
    std::string name;
    int port = 0;
    int proto = 0;
    bool tls = false;
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
SaveBackup parseSaveBackup(const Json& v);
std::vector<SaveBackup> parseSaveList(const Json& v);
SaveUploadResult parseSaveUpload(const Json& v);
/** `/saves?app=…&type=…` with every field percent-encoded; empty fields are left out. */
std::string saveUploadPath(const SaveUploadQuery& q);

Json encodeDeviceInfo(const DeviceInfo& d);
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
inline std::vector<SaveBackup> parseSaveList(const std::string& text) { return parseSaveList(Json::parse(text)); }
inline SaveUploadResult parseSaveUpload(const std::string& text) { return parseSaveUpload(Json::parse(text)); }

} // namespace nslib
