#pragma once

#include "api/protocol.hpp"
#include "api/url.hpp"

#include <string>
#include <vector>

namespace nslib {

struct DiscoveredServer {
    DiscoveryReply reply;
    std::string address;
    std::string url;
};

/** Broadcast `NSLIB?1` and collect unicast JSON replies for `timeoutMs`. */
std::vector<DiscoveredServer> discoverServers(int timeoutMs = 2000, uint16_t port = kDiscoveryPort);

} // namespace nslib
