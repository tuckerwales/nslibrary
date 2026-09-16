#include "update/ed25519.hpp"

extern "C" {
#include "update/tweetnacl.h"
}

#include <vector>

namespace nslib {

bool ed25519Verify(
    const uint8_t pk[kEd25519PublicKeySize], const uint8_t* msg, size_t msgLen, const uint8_t sig[kEd25519SignatureSize])
{
    if (!pk || !sig || (msgLen && !msg)) return false;
    std::vector<uint8_t> sm(kEd25519SignatureSize + msgLen);
    std::vector<uint8_t> opened(sm.size());
    for (size_t i = 0; i < kEd25519SignatureSize; i++) sm[i] = sig[i];
    if (msgLen) {
        for (size_t i = 0; i < msgLen; i++) sm[kEd25519SignatureSize + i] = msg[i];
    }
    unsigned long long mlen = 0;
    return crypto_sign_open(opened.data(), &mlen, sm.data(), sm.size(), pk) == 0;
}

} // namespace nslib
