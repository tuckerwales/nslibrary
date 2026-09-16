#include "update/apply.hpp"

#include "app/atomic_file.hpp"
#include "transport/resume.hpp"
#include "update/http_get.hpp"
#include "update/verify.hpp"

#include <stdexcept>
#include <string>
#include <vector>

#ifdef __SWITCH__
#include <switch.h>
#include <sys/stat.h>
#endif

namespace nslib {

#ifdef __SWITCH__
namespace {

/**
 * RomFS is mounted from the running .nro and keeps that file open, and the SD card refuses to rename an
 * open file. Release it for the swap; remounting afterwards picks up whichever .nro is now in place.
 */
class RomfsReleased {
public:
    RomfsReleased() { romfsExit(); }
    ~RomfsReleased() { romfsInit(); }
    RomfsReleased(const RomfsReleased&) = delete;
    RomfsReleased& operator=(const RomfsReleased&) = delete;
};

} // namespace
#endif

AvailableUpdate fetchSignedUpdate(const std::string& currentVersion, const std::atomic<bool>* cancel) {
    std::string error;
    GithubReleaseAssets release;
    const std::string body = httpGetString(kGithubLatestUrl, 30000, cancel);
    if (!parseGithubRelease(body, release, error)) {
        throw std::runtime_error(error);
    }
    const auto jsonBytes = httpGetBytes(release.jsonUrl, 60000, cancel);
    const auto sigBytes = httpGetBytes(release.sigUrl, 60000, cancel);
    UpdateManifest manifest =
        verifySignedManifest(jsonBytes.data(), jsonBytes.size(), sigBytes.data(), sigBytes.size(), updatePublicKey());
    if (manifest.version != release.version) {
        throw std::runtime_error("update.json version does not match the GitHub tag");
    }
    AvailableUpdate out;
    out.newer = cmpVersion(manifest.version, currentVersion) > 0;
    out.release = std::move(release);
    out.manifest = std::move(manifest);
    return out;
}

void installVerifiedNro(const UpdateManifest& manifest, const std::vector<uint8_t>& nro, const std::string& destPath) {
    std::string error;
    if (!nroMatchesManifest(nro.data(), nro.size(), manifest, error)) {
        throw std::runtime_error(error);
    }
#ifdef __SWITCH__
    mkdir("sdmc:/switch", 0777);
    mkdir("sdmc:/switch/nslibrary", 0777);
    RomfsReleased romfs;
#endif
    writeFileAtomic(destPath, nro.data(), nro.size());
}

void installSignedNro(const AvailableUpdate& update, const std::string& destPath,
    const std::function<void(uint64_t done, uint64_t total)>& progress, const std::atomic<bool>* cancel)
{
    const uint64_t total = update.manifest.size;
    std::vector<uint8_t> nro;
    nro.reserve(size_t(total));
    httpGetStream(update.release.nroUrl, [&](const uint8_t* p, size_t n) {
        if (nro.size() + n > kMaxUpdateNroBytes) throw std::runtime_error("update is larger than 32 MB");
        nro.insert(nro.end(), p, p + n);
        if (progress) progress(nro.size(), total);
    }, 120000, cancel);
    installVerifiedNro(update.manifest, nro, destPath);
}

} // namespace nslib
