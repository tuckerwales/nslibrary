#pragma once

#include "transport/ITransport.hpp"

#include <atomic>
#include <mutex>
#include <string>
#include <thread>

namespace nslib {

class UsbTransport : public ITransport {
public:
    UsbTransport();
    ~UsbTransport() override;

    UsbTransport(const UsbTransport&) = delete;
    UsbTransport& operator=(const UsbTransport&) = delete;

    static bool available();

    void setToken(std::string token) override { token_ = std::move(token); }
    void setTimeoutMs(long ms) override { timeoutMs_ = ms; }

    HttpResponse request(
        const std::string& method,
        const std::string& path,
        const std::string* jsonBody,
        const std::vector<std::pair<std::string, std::string>>& extraHeaders) override;

    int stream(
        const std::string& path,
        uint64_t offset,
        uint64_t length,
        const std::vector<std::pair<std::string, std::string>>& extraHeaders,
        const std::function<void(const uint8_t*, size_t)>& sink) override;

private:
    std::string token_;
    long timeoutMs_ = 30000;
    uint32_t nextId_ = 1;
    std::mutex mutex_;
    std::atomic<bool> running_{true};
    std::atomic<long long> lastTrafficMs_{0};
    std::thread pingThread_;

    uint32_t exchangeLocked(
        const std::string& method,
        const std::string& path,
        const std::string* jsonBody,
        const std::vector<std::pair<std::string, std::string>>& extraHeaders,
        uint16_t* status,
        std::string* jsonOut,
        const std::function<void(const uint8_t*, size_t)>* sink,
        uint64_t expectedPayload);

    void pingLoop();
};

} // namespace nslib
