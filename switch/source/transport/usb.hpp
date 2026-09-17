#pragma once

#include "transport/ITransport.hpp"

#include <atomic>
#include <functional>
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
    void setConnectTimeoutMs(long ms) override { readyTimeoutMs_ = ms; }
    /** Stops delivering the current stream. The rest of the chunk is drained so framing stays in sync. */
    void abort() override { abort_ = true; }
    void clearAbort() override { abort_ = false; }
    std::string lastStreamError() const override;

    /**
     * Large downloads are split into ranged requests of kStreamChunkBytes. This runs between
     * them with the transport unlocked, so the caller can post progress or poll events.
     */
    void setChunkBoundaryHook(std::function<void()> hook) { chunkHook_ = std::move(hook); }

    static constexpr uint64_t kStreamChunkBytes = 64ull * 1024ull * 1024ull;

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
    long readyTimeoutMs_ = 10000;
    uint32_t nextId_ = 1;
    mutable std::mutex mutex_;
    std::atomic<bool> running_{true};
    std::atomic<bool> abort_{false};
    std::atomic<long long> lastTrafficMs_{0};
    std::thread pingThread_;
    std::function<void()> chunkHook_;
    std::string lastStreamError_;
    uint8_t* buffer_ = nullptr;

    uint32_t exchangeLocked(
        const std::string& method,
        const std::string& path,
        const std::string* jsonBody,
        const std::vector<std::pair<std::string, std::string>>& extraHeaders,
        uint16_t* status,
        std::string* jsonOut,
        const std::function<void(const uint8_t*, size_t)>* sink,
        uint64_t offset,
        uint64_t length);

    void pingLoop();
};

} // namespace nslib
