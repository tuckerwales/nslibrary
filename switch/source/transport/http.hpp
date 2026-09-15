#pragma once

#include "transport/ITransport.hpp"

#include <atomic>
#include <mutex>
#include <optional>
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
    void setConnectTimeoutMs(long ms) override { connectTimeoutMs_ = ms; }
    void abort() override { abort_ = true; }
    void clearAbort() override { abort_ = false; }
    bool aborted() const { return abort_; }
    std::string lastStreamError() const override;

    bool isHttps() const;
    /** CURLOPT_PINNEDPUBLICKEY value (`sha256//…`). Empty disables pinning. */
    void setPinnedPublicKey(std::string pin) { pin_ = std::move(pin); }
    /**
     * Connect without credentials and read the server certificate's public key pin.
     * Returns nullopt for plain HTTP or when the TLS backend does not expose the certificate.
     */
    std::optional<std::string> fetchPublicKeyPin();

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
    std::string pin_;
    long timeoutMs_ = 30000;
    long connectTimeoutMs_ = 10000;
    CURL* curl_ = nullptr;
    mutable std::mutex mutex_;
    std::atomic<bool> abort_{false};
    std::string lastStreamError_;

    void applyCommon(const std::string& url);
};

} // namespace nslib
