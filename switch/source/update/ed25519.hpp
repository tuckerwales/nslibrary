#pragma once

#include <cstddef>
#include <cstdint>

namespace nslib {

constexpr size_t kEd25519PublicKeySize = 32;
constexpr size_t kEd25519SignatureSize = 64;

/** RFC 8032 Ed25519 verify (TweetNaCl). Returns true if `sig` is valid for `msg`. */
bool ed25519Verify(
    const uint8_t pk[kEd25519PublicKeySize], const uint8_t* msg, size_t msgLen, const uint8_t sig[kEd25519SignatureSize]);

} // namespace nslib
