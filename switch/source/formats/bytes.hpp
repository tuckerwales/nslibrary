#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace nslib {

class FormatError : public std::runtime_error {
public:
    std::string code;

    FormatError(std::string code, const std::string& message)
        : std::runtime_error(message), code(std::move(code)) {}
};

class Reader {
public:
    virtual ~Reader() = default;
    virtual uint64_t size() const = 0;
    virtual void read(uint64_t offset, void* dst, size_t n) const = 0;

    std::vector<uint8_t> readExact(uint64_t offset, size_t n) const {
        std::vector<uint8_t> out(n);
        if (n) read(offset, out.data(), n);
        return out;
    }
};

class MemoryReader : public Reader {
public:
    MemoryReader(const uint8_t* data, size_t n) : data_(data), size_(n) {}
    explicit MemoryReader(const std::vector<uint8_t>& v) : MemoryReader(v.data(), v.size()) {}

    uint64_t size() const override { return size_; }

    void read(uint64_t offset, void* dst, size_t n) const override {
        if (offset + n > size_) {
            throw FormatError("TRUNCATED", "read past end of buffer");
        }
        if (n) std::memcpy(dst, data_ + offset, n);
    }

private:
    const uint8_t* data_;
    size_t size_;
};

inline uint16_t readU16(const uint8_t* p) {
    return uint16_t(p[0]) | (uint16_t(p[1]) << 8);
}

inline uint32_t readU32(const uint8_t* p) {
    return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}

inline uint64_t readU64(const uint8_t* p) {
    return uint64_t(readU32(p)) | (uint64_t(readU32(p + 4)) << 32);
}

inline uint64_t readU40(const uint8_t* p) {
    return uint64_t(readU32(p)) | (uint64_t(p[4]) << 32);
}

inline void writeU16(uint8_t* p, uint16_t v) {
    p[0] = uint8_t(v);
    p[1] = uint8_t(v >> 8);
}

inline void writeU32(uint8_t* p, uint32_t v) {
    p[0] = uint8_t(v);
    p[1] = uint8_t(v >> 8);
    p[2] = uint8_t(v >> 16);
    p[3] = uint8_t(v >> 24);
}

inline void writeU64(uint8_t* p, uint64_t v) {
    writeU32(p, uint32_t(v));
    writeU32(p + 4, uint32_t(v >> 32));
}

inline std::string hexLower(const uint8_t* p, size_t n) {
    static const char* k = "0123456789abcdef";
    std::string out(n * 2, '0');
    for (size_t i = 0; i < n; i++) {
        out[i * 2] = k[p[i] >> 4];
        out[i * 2 + 1] = k[p[i] & 0xf];
    }
    return out;
}

inline std::string hexUpper(const uint8_t* p, size_t n) {
    static const char* k = "0123456789ABCDEF";
    std::string out(n * 2, '0');
    for (size_t i = 0; i < n; i++) {
        out[i * 2] = k[p[i] >> 4];
        out[i * 2 + 1] = k[p[i] & 0xf];
    }
    return out;
}

inline std::string titleIdString(uint64_t id) {
    char buf[17];
    std::snprintf(buf, sizeof(buf), "%016llX", static_cast<unsigned long long>(id));
    return buf;
}

inline uint64_t parseTitleId(const std::string& s) {
    if (s.size() != 16) throw FormatError("INVALID", "title ID must be 16 hex digits");
    uint64_t v = 0;
    for (char c : s) {
        v <<= 4;
        if (c >= '0' && c <= '9') v |= uint64_t(c - '0');
        else if (c >= 'a' && c <= 'f') v |= uint64_t(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= uint64_t(c - 'A' + 10);
        else throw FormatError("INVALID", "title ID must be 16 hex digits");
    }
    return v;
}

inline std::string hexOffset(uint64_t n) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "0x%llx", static_cast<unsigned long long>(n));
    return buf;
}

} // namespace nslib
