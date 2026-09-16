#include "transport/discovery.hpp"

#include "api/url.hpp"

#include <algorithm>
#include <arpa/inet.h>
#include <chrono>
#include <cstring>
#include <netinet/in.h>

#ifndef INET_ADDRSTRLEN
#define INET_ADDRSTRLEN 16
#endif
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

namespace nslib {

std::vector<DiscoveredServer> discoverServers(int timeoutMs, uint16_t port) {
    std::vector<DiscoveredServer> out;
    const int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return out;
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &yes, sizeof(yes));
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    sockaddr_in dst{};
    dst.sin_family = AF_INET;
    dst.sin_port = htons(port);
    dst.sin_addr.s_addr = htonl(INADDR_BROADCAST);
    const char* q = kDiscoveryQuery;

    using clock = std::chrono::steady_clock;
    const auto start = clock::now();
    const auto deadline = start + std::chrono::milliseconds(timeoutMs);
    // UDP broadcasts get dropped; send the query a few times across the window.
    constexpr int kSends = 3;
    const auto sendEvery = std::chrono::milliseconds(std::max(1, timeoutMs / (kSends + 1)));
    int sent = 0;
    auto nextSend = start;

    for (;;) {
        auto now = clock::now();
        if (now >= deadline) break;
        if (sent < kSends && now >= nextSend) {
            sendto(fd, q, std::strlen(q), 0, reinterpret_cast<sockaddr*>(&dst), sizeof(dst));
            sent++;
            nextSend = now + sendEvery;
        }
        auto wakeAt = deadline;
        if (sent < kSends && nextSend < wakeAt) wakeAt = nextSend;
        const long waitMs = long(std::chrono::duration_cast<std::chrono::milliseconds>(wakeAt - now).count());

        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(fd, &fds);
        timeval tv{};
        tv.tv_sec = waitMs / 1000;
        tv.tv_usec = (waitMs % 1000) * 1000;
        const int rc = select(fd + 1, &fds, nullptr, nullptr, &tv);
        if (rc < 0) break;
        if (rc == 0) continue;
        char buf[2048];
        sockaddr_in src{};
        socklen_t slen = sizeof(src);
        const ssize_t n = recvfrom(fd, buf, sizeof(buf) - 1, 0, reinterpret_cast<sockaddr*>(&src), &slen);
        if (n <= 0) continue;
        buf[n] = 0;
        try {
            DiscoveredServer s;
            s.reply = parseDiscoveryReply(Json::parse(std::string(buf, size_t(n))));
            char addr[INET_ADDRSTRLEN];
            inet_ntop(AF_INET, &src.sin_addr, addr, sizeof(addr));
            s.address = addr;
            const char* scheme = s.reply.tls ? "https://" : "http://";
            s.url = std::string(scheme) + s.address + ":" + std::to_string(s.reply.port);
            bool seen = false;
            for (const auto& e : out) {
                if (e.reply.serverId == s.reply.serverId) {
                    seen = true;
                    break;
                }
            }
            if (!seen) out.push_back(std::move(s));
        } catch (...) {
        }
    }
    close(fd);
    return out;
}

} // namespace nslib
