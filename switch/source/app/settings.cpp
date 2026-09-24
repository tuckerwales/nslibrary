#include "app/settings.hpp"

#include "api/json.hpp"
#include "app/atomic_file.hpp"

#include <cstdio>
#include <fstream>
#include <random>
#include <sstream>
#include <sys/stat.h>

#ifdef __SWITCH__
#include <switch.h>
#endif

namespace nslib {
namespace {

constexpr const char* kDir = "sdmc:/config/nslibrary";
constexpr const char* kPath = "sdmc:/config/nslibrary/config.json";

std::string formatUuid(const uint8_t b[16]) {
    char out[37];
    std::snprintf(out, sizeof(out),
        "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
    return out;
}

} // namespace

void Settings::load() {
    recoverReplacedFile(kPath);
    std::ifstream in(kPath);
    if (!in) {
        ensureUuid();
        return;
    }
    std::ostringstream ss;
    ss << in.rdbuf();
    try {
        const Json v = Json::parse(ss.str());
        if (v["url"].isString()) url = v["url"].asString();
        if (v["token"].isString()) token = v["token"].asString();
        if (v.has("tlsPin") && v["tlsPin"].isString()) tlsPin = v["tlsPin"].asString();
        if (v["uuid"].isString()) uuid = v["uuid"].asString();
        if (v["name"].isString() && !v["name"].asString().empty()) name = v["name"].asString();
        if (v["defaultTarget"].isString() && !v["defaultTarget"].asString().empty()) {
            defaultTarget = v["defaultTarget"].asString();
        }
        if (v["verifyHash"].isBool()) verifyHash = v["verifyHash"].asBool();
        if (v.has("clearFirmwareRequirement") && v["clearFirmwareRequirement"].isBool()) {
            clearFirmwareRequirement = v["clearFirmwareRequirement"].asBool();
        }
        if (v["useUsb"].isBool()) useUsb = v["useUsb"].asBool();
        if (v.has("librarySort") && v["librarySort"].isString()) librarySort = v["librarySort"].asString();
    } catch (...) {
    }
    ensureUuid();
}

void Settings::save() const {
    mkdir("sdmc:/config", 0777);
    mkdir(kDir, 0777);
    Json o = Json::object();
    o.set("url", Json::string(url));
    o.set("token", Json::string(token));
    o.set("tlsPin", Json::string(tlsPin));
    o.set("uuid", Json::string(uuid));
    o.set("name", Json::string(name));
    o.set("defaultTarget", Json::string(defaultTarget));
    o.set("verifyHash", Json::boolean(verifyHash));
    o.set("clearFirmwareRequirement", Json::boolean(clearFirmwareRequirement));
    o.set("useUsb", Json::boolean(useUsb));
    o.set("librarySort", Json::string(librarySort));
    try {
        writeFileAtomic(kPath, o.dump());
    } catch (const std::exception&) {
        // The SD card is read-only or full; keep running with the in-memory settings.
    }
}

void Settings::ensureUuid() {
    if (uuid.size() == 36) return;
    uint8_t b[16]{};
#ifdef __SWITCH__
    randomGet(b, sizeof(b));
#else
    std::random_device rd;
    for (auto& x : b) x = uint8_t(rd());
#endif
    b[6] = uint8_t((b[6] & 0x0f) | 0x40);
    b[8] = uint8_t((b[8] & 0x3f) | 0x80);
    uuid = formatUuid(b);
}

} // namespace nslib
