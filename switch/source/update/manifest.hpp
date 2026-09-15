#pragma once

#include <cstdint>
#include <string>

namespace nslib {

struct UpdateManifest {
    std::string version;
    std::string sha256;
    uint64_t size = 0;
};

struct GithubReleaseAssets {
    std::string tag;
    std::string version;
    std::string nroUrl;
    std::string jsonUrl;
    std::string sigUrl;
    uint64_t nroSize = 0;
};

/** `update.json`: `{"version":"0.1.1","sha256":"<64 hex>","size":123}` */
bool parseUpdateManifest(const std::string& json, UpdateManifest& out, std::string& error);

/** GitHub `GET /repos/{owner}/{repo}/releases/latest` body. */
bool parseGithubRelease(const std::string& json, GithubReleaseAssets& out, std::string& error);

std::string stripVersionTag(std::string tag);

} // namespace nslib
