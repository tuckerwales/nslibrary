#pragma once

#include "update/manifest.hpp"

#include <cstdint>
#include <functional>
#include <string>

namespace nslib {

constexpr const char* kGithubLatestUrl =
    "https://api.github.com/repos/" NSLIB_GITHUB_REPO "/releases/latest";
constexpr uint64_t kMaxUpdateNroBytes = 32ull * 1024ull * 1024ull;
constexpr const char* kSwitchNroPath = "sdmc:/switch/nslibrary/nslibrary.nro";
constexpr const char* kSwitchNroPartPath = "sdmc:/switch/nslibrary/nslibrary.nro.part";

struct AvailableUpdate {
    bool newer = false;
    GithubReleaseAssets release;
    UpdateManifest manifest;
};

/** Fetch GitHub latest and verify `update.json` with the baked-in public key. */
AvailableUpdate fetchSignedUpdate(const std::string& currentVersion);

/** Download the .nro, check size + SHA-256, write to `destPath` via a `.part` file. */
void installSignedNro(const AvailableUpdate& update, const std::string& destPath,
    const std::function<void(uint64_t done, uint64_t total)>& progress = {});

} // namespace nslib
