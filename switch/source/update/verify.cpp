#include "update/verify.hpp"

#include "formats/bytes.hpp"
#include "formats/crypto.hpp"
#include "update/ed25519.hpp"

#include <algorithm>
#include <cctype>
#include <cstring>

namespace nslib {
namespace {

constexpr uint8_t kProductionUpdatePublicKey[32] = {
    0xb2, 0x46, 0x9e, 0x05, 0x5d, 0xc2, 0xf3, 0x3b,
    0x70, 0xbb, 0xd8, 0x78, 0x3c, 0xca, 0xc0, 0xec,
    0x1e, 0x65, 0x6f, 0xab, 0xbc, 0xd8, 0x90, 0x1d,
    0x71, 0x49, 0x1b, 0x29, 0x2e, 0x3b, 0x1a, 0x5a,
};

} // namespace

const uint8_t* updatePublicKey() { return kProductionUpdatePublicKey; }

bool verifyUpdateDocument(
    const uint8_t* json, size_t jsonLen, const uint8_t* sig, size_t sigLen, const uint8_t pk[kEd25519PublicKeySize])
{
    if (!json || !sig || !pk || jsonLen == 0 || sigLen != kEd25519SignatureSize) return false;
    return ed25519Verify(pk, json, jsonLen, sig);
}

bool nroMatchesManifest(const uint8_t* nro, size_t nroLen, const UpdateManifest& manifest, std::string& error) {
    if (!nro || nroLen == 0) {
        error = "empty nro";
        return false;
    }
    if (nroLen != manifest.size) {
        error = "nro size does not match update.json";
        return false;
    }
    const auto digest = sha256(nro, nroLen);
    const std::string got = hexLower(digest.data(), digest.size());
    std::string expect = manifest.sha256;
    for (char& c : expect) {
        if (c >= 'A' && c <= 'F') c = char(c - 'A' + 'a');
    }
    if (got != expect) {
        error = "nro SHA-256 does not match update.json";
        return false;
    }
    return true;
}

} // namespace nslib
