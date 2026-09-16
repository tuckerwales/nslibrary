#pragma once

#include "transport/ITransport.hpp"

#include <atomic>
#include <mutex>
#include <string>

typedef void CURL;

namespace nslib {

class HttpTransport : public ITransport {
public:
    explicit HttpTransport(std::string baseUrl);
    ~HttpTransport() override;

    HttpTransport(const HttpTransport&) = delete;
    HttpTransport& operator=(const HttpTransport&) = delete;

    void setToken(std::string token) override { token_ = std::move(token); }
    void setTimeoutMs(long ms) override { timeoutMs_ = ms; }
    void abort() override { abort_ = true; }
    bool aborted() const { return abort_; }

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
    std::string baseUrl_;
    std::string token_;
    long timeoutMs_ = 30000;
    CURL* curl_ = nullptr;
    std::mutex mutex_;
    std::atomic<bool> abort_{false};
};

} // namespace nslib
