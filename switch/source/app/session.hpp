#pragma once

#include "api/client.hpp"
#include "api/poller.hpp"
#include "api/protocol.hpp"
#include "app/settings.hpp"
#include "transport/http.hpp"

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace nslib {

class Session {
public:
    static Session& instance();

    Settings settings;

    bool hasUrl() const { return !settings.url.empty(); }
    bool hasToken() const { return !settings.token.empty(); }

    void setUrl(std::string url);
    void forgetDevice();

    HelloResponse hello();
    PairResponse pair(const std::string& code);

    /** hello + installed snapshot + catalog + event poller. */
    void start();
    void stop();

    std::vector<CatalogApp> catalogSnapshot() const;
    std::vector<Job> jobsSnapshot() const;
    DeviceState installedSnapshot() const;
    std::string status() const;

    void refreshCatalog();
    void refreshInstalled();
    void queueInstall(int64_t contentMetaId, const std::string& target = "sd");

    bool isInstalling() const { return installing_; }

private:
    Session() = default;

    mutable std::mutex mutex_;
    std::unique_ptr<HttpTransport> transport_;
    std::unique_ptr<DeviceApiClient> client_;
    std::unique_ptr<HttpTransport> pollTransport_;
    std::unique_ptr<DeviceApiClient> pollClient_;
    std::unique_ptr<EventPoller> poller_;
    std::vector<CatalogApp> catalog_;
    std::vector<Job> jobs_;
    DeviceState installed_;
    int64_t catalogRev_ = 0;
    std::string status_;
    std::atomic<bool> installing_{false};
    std::atomic<bool> cancel_{false};
    Job currentJob_{};

    void ensureClient();
    void onEvent(const DeviceEvent& ev);
    void runInstall(Job job);
    void setStatus(std::string s);
};

} // namespace nslib
