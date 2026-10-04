#pragma once

#include "api/protocol.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace nslib {

/** Patch title IDs are the base ID with the low 12 bits set to 0x800. */
std::string baseTitleIdForPatch(const std::string& patchTitleId);

/** DLC title IDs are the base ID with bit 12 flipped and an index in the low 12 bits. A guess, but a good one. */
std::string baseTitleIdForAddon(const std::string& addonTitleId);

/** The game an installed title belongs to: itself, the game an update patches, or the game a DLC extends. */
std::string applicationIdFor(const InstalledTitle& title);

/** Where Move sends a title stored on `storage`: the other one, or empty when there is no SD card. */
std::string moveTargetFor(const std::string& storage, bool hasSd);

struct InstalledSummary {
    bool baseInstalled = false;
    std::string baseStorage;
    /** Highest installed patch version, 0 when no update is installed. */
    uint32_t patchVersion = 0;
    std::string patchStorage;
};

InstalledSummary summarizeInstalled(const std::vector<InstalledTitle>& titles, const std::string& appId);

/** One summary per base title id, for screens that ask about a whole catalog at once. */
std::unordered_map<std::string, InstalledSummary> summarizeInstalledByApp(const std::vector<InstalledTitle>& titles);

/** Lookup into that map, ignoring hex case. Null when nothing of the title is on the console. */
const InstalledSummary* findInstalled(
    const std::unordered_map<std::string, InstalledSummary>& byApp, const std::string& appId);

struct UpdateCandidate {
    const CatalogApp* app = nullptr;
    uint32_t installed = 0;
    uint32_t newest = 0;
};

/** Library updates newer than what is installed, only for games whose base is on this console. */
std::vector<UpdateCandidate> findUpdates(const std::vector<CatalogApp>& catalog, const std::vector<InstalledTitle>& titles);

} // namespace nslib
