#include "update/apply.hpp"

#include "transport/resume.hpp"
#include "update/http_get.hpp"
#include "update/verify.hpp"

#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef __SWITCH__
#include <sys/stat.h>
#endif

namespace nslib {
namespace {

void writeFileAtomic(const std::string& dest, const std::string& part, const std::vector<uint8_t>& data) {
#ifdef __SWITCH__
    mkdir("sdmc:/switch", 0777);
    mkdir("sdmc:/switch/nslibrary", 0777);
#endif
    FILE* f = fopen(part.c_str(), "wb");
    if (!f) throw std::runtime_error("Could not write the update file");
    const size_t n = fwrite(data.data(), 1, data.size(), f);
    fclose(f);
    if (n != data.size()) {
        remove(part.c_str());
        throw std::runtime_error("Could not write the update file");
    }
    remove(dest.c_str());
    if (rename(part.c_str(), dest.c_str()) != 0) {
        remove(part.c_str());
        throw std::runtime_error("Could not replace nslibrary.nro");
    }
}

} // namespace

AvailableUpdate fetchSignedUpdate(const std::string& currentVersion) {
    std::string error;
    GithubReleaseAssets release;
    const std::string body = httpGetString(kGithubLatestUrl);
    if (!parseGithubRelease(body, release, error)) {
        throw std::runtime_error(error);
    }
    const auto jsonBytes = httpGetBytes(release.jsonUrl);
    const auto sigBytes = httpGetBytes(release.sigUrl);
    if (!verifyUpdateDocument(
            jsonBytes.data(), jsonBytes.size(), sigBytes.data(), sigBytes.size(), updatePublicKey())) {
        throw std::runtime_error("The GitHub release is not signed with the NSLibrary update key");
    }
    UpdateManifest manifest;
    const std::string json(jsonBytes.begin(), jsonBytes.end());
    if (!parseUpdateManifest(json, manifest, error)) throw std::runtime_error(error);
    if (manifest.version != release.version) {
        throw std::runtime_error("update.json version does not match the GitHub tag");
    }
    if (manifest.size == 0 || manifest.size > kMaxUpdateNroBytes) {
        throw std::runtime_error("update.json size is not plausible");
    }
    AvailableUpdate out;
    out.newer = cmpVersion(manifest.version, currentVersion) > 0;
    out.release = std::move(release);
    out.manifest = std::move(manifest);
    return out;
}

void installSignedNro(const AvailableUpdate& update, const std::string& destPath,
    const std::function<void(uint64_t done, uint64_t total)>& progress)
{
    const uint64_t total = update.manifest.size;
    std::vector<uint8_t> nro;
    nro.reserve(size_t(total));
    httpGetStream(update.release.nroUrl, [&](const uint8_t* p, size_t n) {
        if (nro.size() + n > kMaxUpdateNroBytes) throw std::runtime_error("update is larger than 32 MB");
        nro.insert(nro.end(), p, p + n);
        if (progress) progress(nro.size(), total);
    });
    std::string error;
    if (!nroMatchesManifest(nro.data(), nro.size(), update.manifest, error)) {
        throw std::runtime_error(error);
    }
    const std::string part = destPath + ".part";
    writeFileAtomic(destPath, part, nro);
}

} // namespace nslib
