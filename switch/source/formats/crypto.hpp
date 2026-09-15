#pragma once

#include "formats/bytes.hpp"

#ifdef __SWITCH__
#include <switch.h>
#endif

#include <array>
#include <cstddef>
#include <cstdint>

namespace nslib {

/** AES-128-CTR at an absolute NCA offset: counter = nonce (8 bytes) || BE64(offset >> 4). */
void aesCtrXor(const uint8_t key[16], const uint8_t cryptoCounter[16], uint64_t absoluteOffset,
    uint8_t* data, size_t n);

class Sha256 {
public:
    Sha256();
    void update(const void* data, size_t n);
    void final(uint8_t out[32]);
    std::array<uint8_t, 32> digest();

private:
#ifdef __SWITCH__
    Sha256Context ctx_{};
#else
    uint32_t state_[8]{};
    uint64_t bitlen_ = 0;
    uint8_t buf_[64]{};
    size_t bufLen_ = 0;
    void transform(const uint8_t block[64]);
#endif
};

std::array<uint8_t, 32> sha256(const void* data, size_t n);

} // namespace nslib
