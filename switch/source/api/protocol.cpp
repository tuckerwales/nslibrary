#include "api/protocol.hpp"

namespace nslib {
namespace {

int64_t reqInt(const Json& v, const char* what) {
    if (v.isNull()) throw JsonError(std::string("missing ") + what);
    return v.asInt();
}

uint64_t reqUint(const Json& v, const char* what) {
    if (v.isNull()) throw JsonError(std::string("missing ") + what);
    return v.asUint();
}

std::string reqString(const Json& v, const char* what) {
    if (v.isNull() || !v.isString()) throw JsonError(std::string("missing string ") + what);
    return v.asString();
}

CatalogContentRef parseContentRef(const Json& v) {
    if (!v.isArray() || v.size() != 4) throw JsonError("content ref must be a 4-tuple");
    CatalogContentRef r;
    r.version = uint32_t(v[0].asUint());
    r.contentMetaId = v[1].asInt();
    r.size = v[2].asUint();
    r.format = v[3].asString();
    return r;
}

CatalogAddon parseAddon(const Json& v) {
    if (!v.isArray() || v.size() != 5) throw JsonError("addon must be a 5-tuple");
    CatalogAddon a;
    a.titleId = v[0].asString();
    a.version = uint32_t(v[1].asUint());
    a.name = v[2].asString();
    a.contentMetaId = v[3].asInt();
    a.size = v[4].asUint();
    return a;
}

CatalogApp parseApp(const Json& v) {
    if (!v.isObject()) throw JsonError("catalog app must be an object");
    CatalogApp a;
    a.id = reqString(v["i"], "app.i");
    a.name = reqString(v["n"], "app.n");
    if (v.has("p") && v["p"].isString()) a.publisher = v["p"].asString();
    if (v.has("ic") && !v["ic"].isNull()) a.iconRev = v["ic"].asInt();
    if (v.has("rsv") && !v["rsv"].isNull()) a.requiredSysVersion = uint32_t(v["rsv"].asUint());
    if (v.has("b") && !v["b"].isNull()) a.base = parseContentRef(v["b"]);
    if (v.has("u") && v["u"].isArray()) {
        for (const auto& item : v["u"].items()) a.updates.push_back(parseContentRef(item));
    }
    if (v.has("d") && v["d"].isArray()) {
        for (const auto& item : v["d"].items()) a.dlc.push_back(parseAddon(item));
    }
    return a;
}

InstalledTitle parseInstalled(const Json& v) {
    if (!v.isArray() || v.size() != 4) throw JsonError("installed title must be a 4-tuple");
    InstalledTitle t;
    t.titleId = v[0].asString();
    t.version = uint32_t(v[1].asUint());
    t.type = v[2].asString();
    t.storage = v[3].asString();
    return t;
}

SpacePair parseSpace(const Json& v) {
    if (!v.isArray() || v.size() != 2) throw JsonError("space must be [free, total]");
    return SpacePair{v[0].asUint(), v[1].asUint()};
}

} // namespace

std::optional<ApiErrorBody> tryParseError(const Json& v) {
    if (!v.isObject() || !v.has("error")) return std::nullopt;
    const Json& e = v["error"];
    if (!e.isObject()) return std::nullopt;
    ApiErrorBody out;
    out.code = reqString(e["code"], "error.code");
    out.msg = reqString(e["msg"], "error.msg");
    return out;
}

ApiErrorBody parseError(const Json& v) {
    auto e = tryParseError(v);
    if (!e) throw JsonError("expected an error body");
    return *e;
}

PairRequest parsePairRequest(const Json& v) {
    PairRequest r;
    r.code = reqString(v["code"], "code");
    r.device.deviceUuid = reqString(v["deviceUuid"], "deviceUuid");
    r.device.name = reqString(v["name"], "name");
    r.device.fw = reqString(v["fw"], "fw");
    r.device.amsVersion = reqString(v["amsVersion"], "amsVersion");
    r.device.appVersion = reqString(v["appVersion"], "appVersion");
    return r;
}

PairResponse parsePairResponse(const Json& v) {
    PairResponse r;
    r.token = reqString(v["token"], "token");
    r.deviceId = reqInt(v["deviceId"], "deviceId");
    r.serverId = reqString(v["serverId"], "serverId");
    r.serverName = reqString(v["serverName"], "serverName");
    return r;
}

HelloResponse parseHello(const Json& v) {
    HelloResponse r;
    r.serverId = reqString(v["serverId"], "serverId");
    r.serverName = reqString(v["serverName"], "serverName");
    r.proto = int(reqInt(v["proto"], "proto"));
    r.catalogRev = reqInt(v["catalogRev"], "catalogRev");
    if (v.has("caps") && v["caps"].isArray()) {
        for (const auto& c : v["caps"].items()) r.caps.push_back(c.asString());
    }
    if (v.has("appLatest") && v["appLatest"].isString()) r.appLatest = v["appLatest"].asString();
    return r;
}

DeviceState parseDeviceState(const Json& v) {
    DeviceState s;
    s.fw = reqString(v["fw"], "fw");
    s.ams = reqString(v["ams"], "ams");
    const Json& space = v["space"];
    if (!space.isObject()) throw JsonError("state.space must be an object");
    if (space.has("sd") && !space["sd"].isNull()) s.sd = parseSpace(space["sd"]);
    s.nand = parseSpace(space["nand"]);
    if (v.has("titles") && v["titles"].isArray()) {
        for (const auto& t : v["titles"].items()) s.titles.push_back(parseInstalled(t));
    }
    return s;
}

CatalogResponse parseCatalog(const Json& v) {
    CatalogResponse r;
    r.rev = reqInt(v["rev"], "rev");
    r.full = v["full"].asBool();
    if (v.has("apps") && v["apps"].isArray()) {
        for (const auto& a : v["apps"].items()) r.apps.push_back(parseApp(a));
    }
    if (v.has("del") && v["del"].isArray()) {
        for (const auto& d : v["del"].items()) r.del.push_back(d.asString());
    }
    if (v.has("next") && !v["next"].isNull()) r.next = v["next"].asString();
    return r;
}

Job parseJob(const Json& v) {
    Job j;
    j.id = reqInt(v["id"], "id");
    j.contentMetaId = reqInt(v["contentMetaId"], "contentMetaId");
    j.fileId = reqInt(v["fileId"], "fileId");
    j.titleId = reqString(v["titleId"], "titleId");
    j.version = uint32_t(reqUint(v["version"], "version"));
    j.type = reqString(v["type"], "type");
    j.name = reqString(v["name"], "name");
    j.size = reqUint(v["size"], "size");
    j.format = reqString(v["format"], "format");
    j.target = reqString(v["target"], "target");
    j.status = reqString(v["status"], "status");
    return j;
}

EventsResponse parseEvents(const Json& v) {
    EventsResponse r;
    r.cursor = reqString(v["cursor"], "cursor");
    if (v.has("ev") && v["ev"].isArray()) {
        for (const auto& e : v["ev"].items()) {
            if (!e.isObject() || !e.has("t") || !e["t"].isString()) continue;
            DeviceEvent ev;
            ev.t = e["t"].asString();
            try {
                if (ev.t == "job.queued") ev.job = parseJob(e["job"]);
                else if (ev.t == "job.cancel") ev.id = reqInt(e["id"], "id");
                else if (ev.t == "catalog") ev.rev = reqInt(e["rev"], "rev");
                else continue;
            } catch (const JsonError&) {
                continue;
            }
            r.ev.push_back(std::move(ev));
        }
    }
    return r;
}

JobProgress parseJobProgress(const Json& v) {
    JobProgress p;
    p.phase = reqString(v["phase"], "phase");
    if (v.has("item") && v["item"].isString()) p.item = v["item"].asString();
    p.done = reqUint(v["done"], "done");
    p.total = reqUint(v["total"], "total");
    p.bps = v["bps"].asNumber();
    return p;
}

DiscoveryReply parseDiscoveryReply(const Json& v) {
    DiscoveryReply r;
    r.serverId = reqString(v["serverId"], "serverId");
    r.name = reqString(v["name"], "name");
    r.port = int(reqInt(v["port"], "port"));
    r.proto = int(reqInt(v["proto"], "proto"));
    if (v.has("tls") && v["tls"].isBool()) r.tls = v["tls"].asBool();
    return r;
}

Json encodeDeviceInfo(const DeviceInfo& d) {
    Json o = Json::object();
    o.set("deviceUuid", Json::string(d.deviceUuid));
    o.set("name", Json::string(d.name));
    o.set("fw", Json::string(d.fw));
    o.set("amsVersion", Json::string(d.amsVersion));
    o.set("appVersion", Json::string(d.appVersion));
    return o;
}

Json encodePairRequest(const PairRequest& r) {
    Json o = encodeDeviceInfo(r.device);
    o.set("code", Json::string(r.code));
    return o;
}

Json encodeDeviceState(const DeviceState& s) {
    Json space = Json::object();
    if (s.sd) {
        Json sd = Json::array();
        sd.push(Json::number(int64_t(s.sd->free)));
        sd.push(Json::number(int64_t(s.sd->total)));
        space.set("sd", std::move(sd));
    } else {
        space.set("sd", Json::null());
    }
    Json nand = Json::array();
    nand.push(Json::number(int64_t(s.nand.free)));
    nand.push(Json::number(int64_t(s.nand.total)));
    space.set("nand", std::move(nand));

    Json titles = Json::array();
    for (const auto& t : s.titles) {
        Json row = Json::array();
        row.push(Json::string(t.titleId));
        row.push(Json::number(int64_t(t.version)));
        row.push(Json::string(t.type));
        row.push(Json::string(t.storage));
        titles.push(std::move(row));
    }

    Json o = Json::object();
    o.set("fw", Json::string(s.fw));
    o.set("ams", Json::string(s.ams));
    o.set("space", std::move(space));
    o.set("titles", std::move(titles));
    return o;
}

Json encodeJobProgress(const JobProgress& p) {
    Json o = Json::object();
    o.set("phase", Json::string(p.phase));
    if (p.item) o.set("item", Json::string(*p.item));
    o.set("done", Json::number(int64_t(p.done)));
    o.set("total", Json::number(int64_t(p.total)));
    o.set("bps", Json::number(p.bps));
    return o;
}

Json encodeJobComplete(const JobComplete& c) {
    Json o = Json::object();
    o.set("ok", Json::boolean(c.ok));
    if (c.result) o.set("result", Json::string(*c.result));
    if (c.msg) o.set("msg", Json::string(*c.msg));
    return o;
}

Json encodeCreateJob(int64_t contentMetaId, const std::string& target) {
    Json o = Json::object();
    o.set("contentMetaId", Json::number(contentMetaId));
    o.set("target", Json::string(target));
    return o;
}

} // namespace nslib
