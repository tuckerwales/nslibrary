#include "installed/compare.hpp"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <unordered_map>

namespace nslib {
namespace {

std::string upper(std::string s) {
    for (char& c : s) {
        if (c >= 'a' && c <= 'f') c = char(c - 'a' + 'A');
    }
    return s;
}

} // namespace

std::string baseTitleIdForPatch(const std::string& patchTitleId) {
    if (patchTitleId.size() != 16) return upper(patchTitleId);
    const uint64_t id = std::strtoull(patchTitleId.c_str(), nullptr, 16);
    char buf[17];
    std::snprintf(buf, sizeof(buf), "%016llX", static_cast<unsigned long long>(id & ~uint64_t(0xfff)));
    return buf;
}

InstalledSummary summarizeInstalled(const std::vector<InstalledTitle>& titles, const std::string& appId) {
    InstalledSummary out;
    const std::string id = upper(appId);
    for (const auto& t : titles) {
        if (t.type == "application" && upper(t.titleId) == id) {
            out.baseInstalled = true;
            out.baseStorage = t.storage;
        } else if (t.type == "patch" && baseTitleIdForPatch(t.titleId) == id && t.version >= out.patchVersion) {
            out.patchVersion = t.version;
            out.patchStorage = t.storage;
        }
    }
    return out;
}

std::vector<UpdateCandidate> findUpdates(const std::vector<CatalogApp>& catalog, const std::vector<InstalledTitle>& titles) {
    std::unordered_map<std::string, InstalledSummary> byApp;
    for (const auto& t : titles) {
        const std::string key = t.type == "patch" ? baseTitleIdForPatch(t.titleId) : upper(t.titleId);
        auto& s = byApp[key];
        if (t.type == "application") {
            s.baseInstalled = true;
            s.baseStorage = t.storage;
        } else if (t.type == "patch" && t.version >= s.patchVersion) {
            s.patchVersion = t.version;
            s.patchStorage = t.storage;
        }
    }

    std::vector<UpdateCandidate> out;
    for (const auto& app : catalog) {
        if (app.updates.empty()) continue;
        auto it = byApp.find(upper(app.id));
        if (it == byApp.end() || !it->second.baseInstalled) continue;
        uint32_t newest = 0;
        for (const auto& u : app.updates) newest = std::max(newest, u.version);
        if (newest <= it->second.patchVersion) continue;
        out.push_back(UpdateCandidate{&app, it->second.patchVersion, newest});
    }
    return out;
}

} // namespace nslib
