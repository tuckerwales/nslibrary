#include "formats/crypto.hpp"

#include <algorithm>
#include <cstring>

#ifdef __SWITCH__
#include <switch.h>
#endif

namespace nslib {
#ifndef __SWITCH__
namespace {

constexpr uint8_t kSbox[256] = {
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
};

constexpr uint8_t kRcon[11] = {0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36};

inline uint8_t xtime(uint8_t x) { return uint8_t((x << 1) ^ ((x & 0x80) ? 0x1b : 0)); }

void aesExpand(const uint8_t key[16], uint8_t rk[176]) {
    std::memcpy(rk, key, 16);
    for (int i = 4; i < 44; i++) {
        uint8_t t[4];
        std::memcpy(t, rk + (i - 1) * 4, 4);
        if (i % 4 == 0) {
            const uint8_t tmp = t[0];
            t[0] = uint8_t(kSbox[t[1]] ^ kRcon[i / 4]);
            t[1] = kSbox[t[2]];
            t[2] = kSbox[t[3]];
            t[3] = kSbox[tmp];
        }
        for (int j = 0; j < 4; j++) rk[i * 4 + j] = uint8_t(rk[(i - 4) * 4 + j] ^ t[j]);
    }
}

void aesEncryptBlock(const uint8_t rk[176], const uint8_t in[16], uint8_t out[16]) {
    uint8_t s[16];
    for (int i = 0; i < 16; i++) s[i] = uint8_t(in[i] ^ rk[i]);
    for (int round = 1; round <= 10; round++) {
        uint8_t t[16];
        for (int i = 0; i < 16; i++) t[i] = kSbox[s[i]];
        uint8_t r[16];
        r[0] = t[0];
        r[1] = t[5];
        r[2] = t[10];
        r[3] = t[15];
        r[4] = t[4];
        r[5] = t[9];
        r[6] = t[14];
        r[7] = t[3];
        r[8] = t[8];
        r[9] = t[13];
        r[10] = t[2];
        r[11] = t[7];
        r[12] = t[12];
        r[13] = t[1];
        r[14] = t[6];
        r[15] = t[11];
        if (round < 10) {
            for (int c = 0; c < 4; c++) {
                const uint8_t a0 = r[c * 4], a1 = r[c * 4 + 1], a2 = r[c * 4 + 2], a3 = r[c * 4 + 3];
                s[c * 4] = uint8_t(xtime(a0) ^ xtime(a1) ^ a1 ^ a2 ^ a3);
                s[c * 4 + 1] = uint8_t(a0 ^ xtime(a1) ^ xtime(a2) ^ a2 ^ a3);
                s[c * 4 + 2] = uint8_t(a0 ^ a1 ^ xtime(a2) ^ xtime(a3) ^ a3);
                s[c * 4 + 3] = uint8_t(xtime(a0) ^ a0 ^ a1 ^ a2 ^ xtime(a3));
            }
        } else {
            std::memcpy(s, r, 16);
        }
        for (int i = 0; i < 16; i++) s[i] = uint8_t(s[i] ^ rk[round * 16 + i]);
    }
    std::memcpy(out, s, 16);
}

void ctrBlock(const uint8_t rk[176], const uint8_t nonce[8], uint64_t blockIndex, uint8_t out[16]) {
    uint8_t ctr[16];
    std::memcpy(ctr, nonce, 8);
    for (int i = 0; i < 8; i++) ctr[15 - i] = uint8_t(blockIndex >> (8 * i));
    aesEncryptBlock(rk, ctr, out);
}

} // namespace
#endif

void aesCtrXor(const uint8_t key[16], const uint8_t cryptoCounter[16], uint64_t absoluteOffset,
    uint8_t* data, size_t n)
{
    if (!n) return;
#ifdef __SWITCH__
    Aes128CtrContext ctx;
    uint8_t iv[16];
    const uint64_t aligned = absoluteOffset & ~uint64_t(15);
    std::memcpy(iv, cryptoCounter, 8);
    const uint64_t blockIndex = aligned / 16;
    for (int i = 0; i < 8; i++) iv[15 - i] = uint8_t(blockIndex >> (8 * i));
    aes128CtrContextCreate(&ctx, key, iv);
    const size_t skip = size_t(absoluteOffset - aligned);
    if (skip) {
        uint8_t dummy[16]{};
        aes128CtrCrypt(&ctx, dummy, dummy, skip);
    }
    aes128CtrCrypt(&ctx, data, data, n);
#else
    uint8_t rk[176];
    aesExpand(key, rk);
    uint64_t off = absoluteOffset;
    size_t i = 0;
    while (i < n) {
        uint8_t ks[16];
        ctrBlock(rk, cryptoCounter, off / 16, ks);
        const size_t start = size_t(off % 16);
        const size_t take = std::min(size_t(16 - start), n - i);
        for (size_t j = 0; j < take; j++) data[i + j] ^= ks[start + j];
        i += take;
        off += take;
    }
#endif
}

#ifndef __SWITCH__
namespace {

inline uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

constexpr uint32_t kK[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

inline uint32_t be32(const uint8_t* p) {
    return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | uint32_t(p[3]);
}

inline void wrbe32(uint8_t* p, uint32_t v) {
    p[0] = uint8_t(v >> 24);
    p[1] = uint8_t(v >> 16);
    p[2] = uint8_t(v >> 8);
    p[3] = uint8_t(v);
}

} // namespace
#endif

Sha256::Sha256() {
#ifdef __SWITCH__
    sha256ContextCreate(&ctx_);
#else
    state_[0] = 0x6a09e667;
    state_[1] = 0xbb67ae85;
    state_[2] = 0x3c6ef372;
    state_[3] = 0xa54ff53a;
    state_[4] = 0x510e527f;
    state_[5] = 0x9b05688c;
    state_[6] = 0x1f83d9ab;
    state_[7] = 0x5be0cd19;
#endif
}

#ifndef __SWITCH__
void Sha256::transform(const uint8_t block[64]) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) w[i] = be32(block + i * 4);
    for (int i = 16; i < 64; i++) {
        const uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        const uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = state_[0], b = state_[1], c = state_[2], d = state_[3];
    uint32_t e = state_[4], f = state_[5], g = state_[6], h = state_[7];
    for (int i = 0; i < 64; i++) {
        const uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const uint32_t ch = (e & f) ^ ((~e) & g);
        const uint32_t t1 = h + S1 + ch + kK[i] + w[i];
        const uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        const uint32_t t2 = S0 + maj;
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }
    state_[0] += a;
    state_[1] += b;
    state_[2] += c;
    state_[3] += d;
    state_[4] += e;
    state_[5] += f;
    state_[6] += g;
    state_[7] += h;
}
#endif

void Sha256::update(const void* data, size_t n) {
#ifdef __SWITCH__
    sha256ContextUpdate(&ctx_, data, n);
#else
    const auto* p = static_cast<const uint8_t*>(data);
    bitlen_ += uint64_t(n) * 8;
    while (n) {
        const size_t take = std::min(n, size_t(64 - bufLen_));
        std::memcpy(buf_ + bufLen_, p, take);
        bufLen_ += take;
        p += take;
        n -= take;
        if (bufLen_ == 64) {
            transform(buf_);
            bufLen_ = 0;
        }
    }
#endif
}

void Sha256::final(uint8_t out[32]) {
#ifdef __SWITCH__
    sha256ContextGetHash(&ctx_, out);
#else
    buf_[bufLen_++] = 0x80;
    if (bufLen_ > 56) {
        while (bufLen_ < 64) buf_[bufLen_++] = 0;
        transform(buf_);
        bufLen_ = 0;
    }
    while (bufLen_ < 56) buf_[bufLen_++] = 0;
    wrbe32(buf_ + 56, uint32_t(bitlen_ >> 32));
    wrbe32(buf_ + 60, uint32_t(bitlen_));
    transform(buf_);
    for (int i = 0; i < 8; i++) wrbe32(out + i * 4, state_[i]);
#endif
}

std::array<uint8_t, 32> Sha256::digest() {
    uint8_t out[32];
    final(out);
    std::array<uint8_t, 32> a{};
    std::memcpy(a.data(), out, 32);
    return a;
}

std::array<uint8_t, 32> sha256(const void* data, size_t n) {
#ifdef __SWITCH__
    std::array<uint8_t, 32> out{};
    sha256CalculateHash(out.data(), data, n);
    return out;
#else
    Sha256 h;
    h.update(data, n);
    return h.digest();
#endif
}

} // namespace nslib
