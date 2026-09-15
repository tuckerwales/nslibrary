#include "formats/ticket.hpp"

#include <cstring>
#include <utility>

namespace nslib {
namespace {

// signature type → {signature size, padding}
std::pair<uint32_t, uint32_t> signatureLayout(uint32_t type) {
    switch (type) {
        case 0x10000: return {0x200, 0x3c};
        case 0x10001: return {0x100, 0x3c};
        case 0x10002: return {0x3c, 0x40};
        case 0x10003: return {0x200, 0x3c};
        case 0x10004: return {0x100, 0x3c};
        case 0x10005: return {0x3c, 0x40};
        case 0x10006: return {0x14, 0x28};
        default: return {0, 0};
    }
}

constexpr size_t kTicketDataSize = 0x180;

} // namespace

TicketInfo parseTicket(const uint8_t* data, size_t size) {
    if (size < 4) throw FormatError("TRUNCATED", "ticket is shorter than its signature type");
    TicketInfo info;
    info.signatureType = readU32(data);
    auto layout = signatureLayout(info.signatureType);
    if (layout.first == 0 && info.signatureType != 0) {
        throw FormatError("UNSUPPORTED", "unknown ticket signature type " + hexOffset(info.signatureType));
    }
    if (layout.first == 0) {
        throw FormatError("UNSUPPORTED", "unknown ticket signature type " + hexOffset(info.signatureType));
    }

    const size_t dataStart = 4 + layout.first + layout.second;
    if (size < dataStart + kTicketDataSize) {
        throw FormatError("TRUNCATED", "ticket needs " + hexOffset(dataStart + kTicketDataSize) +
            " bytes, has " + hexOffset(size));
    }

    const uint8_t* issuer = data + dataStart;
    size_t issuerLen = 0;
    while (issuerLen < 0x40 && issuer[issuerLen] != 0) issuerLen++;
    info.issuer.assign(reinterpret_cast<const char*>(issuer), issuerLen);
    info.titleKeyType = data[dataStart + 0x141] == 1 ? TitleKeyType::Personalized : TitleKeyType::Common;
    info.keyGeneration = data[dataStart + 0x145];
    info.rightsId = hexUpper(data + dataStart + 0x160, 0x10);
    info.titleId = info.rightsId.substr(0, 16);
    info.titleKeyBlock.assign(data + dataStart + 0x40, data + dataStart + 0x140);
    return info;
}

} // namespace nslib
