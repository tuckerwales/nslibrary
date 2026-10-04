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

std::string baseTitleIdForAddon(const std::string& addonTitleId) {
    if (addonTitleId.size() != 16) return upper(addonTitleId);
    const uint64_t id = std::strtoull(addonTitleId.c_str(), nullptr, 16);
    char buf[17];
    std::snprintf(buf, sizeof(buf), "%016llX", static_cast<unsigned long long>((id & ~uint64_t(0xfff)) ^ 0x1000));
    return buf;
}

std::string applicationIdFor(const InstalledTitle& title) {
    if (title.type == "patch") return baseTitleIdForPatch(title.titleId);
    if (title.type == "addon" || title.type == "aoc") return baseTitleIdForAddon(title.titleId);
    return upper(title.titleId);
}

std::string moveTargetFor(const std::string& storage, bool hasSd) {
    if (storage == "sd") return "nand";
    if (storage == "nand" && hasSd) return "sd";
    return "";
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

std::unordered_map<std::string, InstalledSummary> summarizeInstalledByApp(const std::vector<InstalledTitle>& titles) {
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
    return byApp;
}

const InstalledSummary* findInstalled(
    const std::unordered_map<std::string, InstalledSummary>& byApp, const std::string& appId)
{
    auto it = byApp.find(upper(appId));
    return it == byApp.end() ? nullptr : &it->second;
}

std::vector<UpdateCandidate> findUpdates(const std::vector<CatalogApp>& catalog, const std::vector<InstalledTitle>& titles) {
    const auto byApp = summarizeInstalledByApp(titles);

    std::vector<UpdateCandidate> out;
    for (const auto& app : catalog) {
        if (app.updates.empty()) continue;
        const InstalledSummary* s = findInstalled(byApp, app.id);
        if (!s || !s->baseInstalled) continue;
        uint32_t newest = 0;
        for (const auto& u : app.updates) newest = std::max(newest, u.version);
        if (newest <= s->patchVersion) continue;
        out.push_back(UpdateCandidate{&app, s->patchVersion, newest});
    }
    return out;
}

} // namespace nslib
