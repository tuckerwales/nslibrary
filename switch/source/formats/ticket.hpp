#pragma once

#include "formats/bytes.hpp"

#include <string>
#include <vector>

namespace nslib {

enum class TitleKeyType { Common, Personalized };

struct TicketInfo {
    uint32_t signatureType = 0;
    std::string issuer;
    TitleKeyType titleKeyType = TitleKeyType::Common;
    uint8_t keyGeneration = 0;
    std::string rightsId;
    std::string titleId;
    std::vector<uint8_t> titleKeyBlock;
};

TicketInfo parseTicket(const uint8_t* data, size_t size);
inline TicketInfo parseTicket(const std::vector<uint8_t>& data) { return parseTicket(data.data(), data.size()); }

} // namespace nslib
