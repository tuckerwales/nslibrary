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
    /** Non-fatal problems worth showing while the install keeps going (low battery, newer firmware needed). */
    std::function<void(const std::string&)> warn;
};

/** Where the engine records placeholders it has not yet registered or deleted. */
constexpr const char* kPlaceholderJournalPath = "sdmc:/config/nslibrary/placeholders.txt";

/** Delete placeholders left behind by a crash or power loss during an earlier install. */
void cleanupStalePlaceholders();

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
