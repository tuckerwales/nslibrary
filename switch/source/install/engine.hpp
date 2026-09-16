#pragma once

#include "api/client.hpp"
#include "api/protocol.hpp"

#include <atomic>
#include <functional>
#include <stdexcept>
#include <string>

namespace nslib {

class InstallError : public std::runtime_error {
public:
    std::string result;
    InstallError(std::string result, const std::string& msg)
        : std::runtime_error(msg), result(std::move(result)) {}
};

struct InstallOptions {
    bool verifyHash = true;
};

class InstallEngine {
public:
    using ProgressFn = std::function<void(const JobProgress&)>;

    InstallEngine(DeviceApiClient& client, std::atomic<bool>* cancel = nullptr, InstallOptions opt = {});

    void install(const Job& job, ProgressFn progress);

private:
    DeviceApiClient& client_;
    std::atomic<bool>* cancel_;
    InstallOptions opt_;
};

} // namespace nslib
