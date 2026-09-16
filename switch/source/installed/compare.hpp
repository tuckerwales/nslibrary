#pragma once

#include "api/protocol.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace nslib {

/** Patch title IDs are the base ID with the low 12 bits set to 0x800. */
std::string baseTitleIdForPatch(const std::string& patchTitleId);

struct InstalledSummary {
    bool baseInstalled = false;
    std::string baseStorage;
    /** Highest installed patch version, 0 when no update is installed. */
    uint32_t patchVersion = 0;
    std::string patchStorage;
};

InstalledSummary summarizeInstalled(const std::vector<InstalledTitle>& titles, const std::string& appId);

struct UpdateCandidate {
    const CatalogApp* app = nullptr;
    uint32_t installed = 0;
    uint32_t newest = 0;
};

/** Library updates newer than what is installed, only for games whose base is on this console. */
std::vector<UpdateCandidate> findUpdates(const std::vector<CatalogApp>& catalog, const std::vector<InstalledTitle>& titles);

} // namespace nslib
