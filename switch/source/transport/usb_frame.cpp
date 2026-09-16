#include "transport/usb_frame.hpp"

#include <cstring>

namespace nslib {

std::vector<uint8_t> encodeFrameHeader(const FrameHeader& header) {
    if (header.jsonLength > kUsbMaxJsonLength) {
        throw FrameError("TOO_LARGE", "JSON section exceeds limit");
    }
    if (header.payloadLength > kUsbMaxPayloadLength) {
        throw FrameError("TOO_LARGE", "Invalid payload length");
    }
    std::vector<uint8_t> bytes(kUsbFrameHeaderSize, 0);
    std::memcpy(bytes.data(), kUsbFrameMagic, 4);
    writeU16(bytes.data() + 0x04, header.version);
    bytes[0x06] = uint8_t(header.kind);
    bytes[0x07] = header.flags;
    writeU32(bytes.data() + 0x08, header.requestId);
    writeU16(bytes.data() + 0x0c, header.status);
    writeU32(bytes.data() + 0x10, header.jsonLength);
    writeU64(bytes.data() + 0x18, header.payloadLength);
    return bytes;
}

FrameHeader decodeFrameHeader(const uint8_t* bytes, size_t n) {
    if (n < kUsbFrameHeaderSize) {
        throw FrameError("SHORT_HEADER",
            "Frame header needs 32 bytes, got " + std::to_string(n));
    }
    if (std::memcmp(bytes, kUsbFrameMagic, 4) != 0) {
        throw FrameError("BAD_MAGIC", "Frame magic mismatch");
    }
    FrameHeader h;
    h.version = readU16(bytes + 0x04);
    if (h.version != kUsbProtoVersion) {
        throw FrameError("BAD_VERSION", "Unsupported USB protocol version " + std::to_string(h.version));
    }
    const uint8_t kind = bytes[0x06];
    if (kind < 1 || kind > 5) throw FrameError("BAD_KIND", "Unknown frame kind " + std::to_string(kind));
    h.kind = FrameKind(kind);
    h.flags = bytes[0x07];
    h.requestId = readU32(bytes + 0x08);
    h.status = readU16(bytes + 0x0c);
    h.jsonLength = readU32(bytes + 0x10);
    if (h.jsonLength > kUsbMaxJsonLength) {
        throw FrameError("TOO_LARGE", "JSON section exceeds limit");
    }
    h.payloadLength = readU64(bytes + 0x18);
    if (h.payloadLength > kUsbMaxPayloadLength) {
        throw FrameError("TOO_LARGE", "Payload length exceeds safe range");
    }
    return h;
}

std::vector<uint8_t> encodeFrame(const FrameHeader& header, const uint8_t* json, size_t jsonN,
    const uint8_t* payload, size_t payloadN)
{
    FrameHeader h = header;
    h.jsonLength = uint32_t(jsonN);
    h.payloadLength = payloadN;
    auto out = encodeFrameHeader(h);
    out.insert(out.end(), json, json + jsonN);
    if (payloadN) out.insert(out.end(), payload, payload + payloadN);
    return out;
}

} // namespace nslib
