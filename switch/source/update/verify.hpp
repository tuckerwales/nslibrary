#pragma once

#include "update/ed25519.hpp"
#include "update/manifest.hpp"

#include <cstddef>
#include <cstdint>
#include <string>

namespace nslib {

constexpr uint64_t kMaxUpdateNroBytes = 32ull * 1024ull * 1024ull;

/** Production Ed25519 public key that GitHub releases are signed with. */
const uint8_t* updatePublicKey();

bool verifyUpdateDocument(
    const uint8_t* json, size_t jsonLen, const uint8_t* sig, size_t sigLen, const uint8_t pk[kEd25519PublicKeySize]);

/** Verify `update.json` against its signature and parse it. Throws std::runtime_error with a user-facing message. */
UpdateManifest verifySignedManifest(const uint8_t* json, size_t jsonLen, const uint8_t* sig, size_t sigLen,
    const uint8_t pk[kEd25519PublicKeySize]);

bool nroMatchesManifest(const uint8_t* nro, size_t nroLen, const UpdateManifest& manifest, std::string& error);

} // namespace nslib
