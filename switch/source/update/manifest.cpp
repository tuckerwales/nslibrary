#include "update/manifest.hpp"

#include "api/json.hpp"

namespace nslib {
namespace {

bool isHexSha256(const std::string& s) {
    if (s.size() != 64) return false;
    for (char c : s) {
        const bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        if (!ok) return false;
    }
    return true;
}

} // namespace

std::string stripVersionTag(std::string tag) {
    if (!tag.empty() && (tag[0] == 'v' || tag[0] == 'V')) tag.erase(tag.begin());
    return tag;
}

bool parseUpdateManifest(const std::string& json, UpdateManifest& out, std::string& error) {
    try {
        const Json v = Json::parse(json);
        if (!v.isObject()) {
            error = "update.json is not an object";
            return false;
        }
        if (!v.has("version") || !v["version"].isString() || v["version"].asString().empty()) {
            error = "update.json is missing version";
            return false;
        }
        if (!v.has("sha256") || !v["sha256"].isString() || !isHexSha256(v["sha256"].asString())) {
            error = "update.json is missing a SHA-256";
            return false;
        }
        if (!v.has("size") || !v["size"].isNumber() || v["size"].asInt() <= 0) {
            error = "update.json is missing size";
            return false;
        }
        out.version = v["version"].asString();
        out.sha256 = v["sha256"].asString();
        for (char& c : out.sha256) {
            if (c >= 'A' && c <= 'F') c = char(c - 'A' + 'a');
        }
        out.size = uint64_t(v["size"].asInt());
        return true;
    } catch (const JsonError& e) {
        error = e.what();
        return false;
    }
}

bool parseGithubRelease(const std::string& json, GithubReleaseAssets& out, std::string& error) {
    try {
        const Json v = Json::parse(json);
        if (!v.isObject() || !v.has("tag_name") || !v["tag_name"].isString()) {
            error = "GitHub release is missing tag_name";
            return false;
        }
        out.tag = v["tag_name"].asString();
        out.version = stripVersionTag(out.tag);
        out.nroUrl.clear();
        out.jsonUrl.clear();
        out.sigUrl.clear();
        out.nroSize = 0;
        if (!v.has("assets") || !v["assets"].isArray()) {
            error = "GitHub release has no assets";
            return false;
        }
        for (const auto& a : v["assets"].items()) {
            if (!a.isObject() || !a.has("name") || !a.has("browser_download_url")) continue;
            const std::string name = a["name"].asString();
            const std::string url = a["browser_download_url"].asString();
            if (name == "nslibrary.nro") {
                out.nroUrl = url;
                if (a.has("size") && a["size"].isNumber()) out.nroSize = uint64_t(a["size"].asInt());
            } else if (name == "update.json") {
                out.jsonUrl = url;
            } else if (name == "update.json.sig") {
                out.sigUrl = url;
            }
        }
        if (out.nroUrl.empty() || out.jsonUrl.empty() || out.sigUrl.empty()) {
            error = "GitHub release is missing nslibrary.nro, update.json, or update.json.sig";
            return false;
        }
        return true;
    } catch (const JsonError& e) {
        error = e.what();
        return false;
    }
}

} // namespace nslib
