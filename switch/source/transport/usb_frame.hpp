#pragma once

#include "formats/bytes.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace nslib {

constexpr size_t kUsbFrameHeaderSize = 32;
constexpr uint16_t kUsbProtoVersion = 1;
constexpr uint32_t kUsbMaxJsonLength = 1u << 20;
constexpr uint64_t kUsbMaxPayloadLength = 9007199254740991ull; // Number.MAX_SAFE_INTEGER
constexpr char kUsbFrameMagic[4] = {'N', 'S', 'L', 'U'};

enum class FrameKind : uint8_t {
    Request = 1,
    Response = 2,
    Cancel = 3,
    Ping = 4,
    Pong = 5,
};

enum class FrameFlags : uint8_t { RawStream = 1 };

struct FrameHeader {
    uint16_t version = kUsbProtoVersion;
    FrameKind kind = FrameKind::Request;
    uint8_t flags = 0;
    uint32_t requestId = 0;
    uint16_t status = 0;
    uint32_t jsonLength = 0;
    uint64_t payloadLength = 0;
};

class FrameError : public std::runtime_error {
public:
    std::string code;
    FrameError(std::string code, const std::string& message)
        : std::runtime_error(message), code(std::move(code)) {}
};

std::vector<uint8_t> encodeFrameHeader(const FrameHeader& header);
FrameHeader decodeFrameHeader(const uint8_t* bytes, size_t n);
inline FrameHeader decodeFrameHeader(const std::vector<uint8_t>& bytes) {
    return decodeFrameHeader(bytes.data(), bytes.size());
}

std::vector<uint8_t> encodeFrame(const FrameHeader& header, const uint8_t* json, size_t jsonN,
    const uint8_t* payload, size_t payloadN);

} // namespace nslib
