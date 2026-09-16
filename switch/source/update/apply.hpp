#pragma once

#include "update/manifest.hpp"
#include "update/verify.hpp"

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace nslib {

constexpr const char* kGithubLatestUrl =
    "https://api.github.com/repos/" NSLIB_GITHUB_REPO "/releases/latest";
constexpr const char* kSwitchNroPath = "sdmc:/switch/nslibrary/nslibrary.nro";

struct AvailableUpdate {
    bool newer = false;
    /** Offered by the paired library server (`GET /update`) rather than a GitHub release. */
    bool fromServer = false;
    GithubReleaseAssets release;
    UpdateManifest manifest;
};

/** Fetch GitHub latest and verify `update.json` with the baked-in public key. */
AvailableUpdate fetchSignedUpdate(const std::string& currentVersion, const std::atomic<bool>* cancel = nullptr);

/** Download the .nro, check size + SHA-256, and swap it into `destPath`. */
void installSignedNro(const AvailableUpdate& update, const std::string& destPath,
    const std::function<void(uint64_t done, uint64_t total)>& progress = {}, const std::atomic<bool>* cancel = nullptr);

/** Check `nro` against an already verified manifest, then swap it into `destPath`. */
void installVerifiedNro(const UpdateManifest& manifest, const std::vector<uint8_t>& nro, const std::string& destPath);

} // namespace nslib
