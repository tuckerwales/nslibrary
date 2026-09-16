#pragma once

#include "api/client.hpp"
#include "api/poller.hpp"
#include "api/protocol.hpp"
#include "app/settings.hpp"
#include "transport/ITransport.hpp"

#include <atomic>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
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
    void setUsb(bool on);
    void forgetDevice();
    PairResponse usbHello();

    HelloResponse hello();
    PairResponse pair(const std::string& code);

    void start();
    void stop();

    std::vector<CatalogApp> catalogSnapshot() const;
    std::vector<Job> jobsSnapshot() const;
    DeviceState installedSnapshot() const;
    std::string status() const;
    JobProgress progressSnapshot() const;
    std::optional<Job> currentJob() const;

    void refreshCatalog();
    void refreshInstalled();
    void queueInstall(int64_t contentMetaId, const std::string& target);
    void cancelJob(int64_t jobId);

    std::vector<uint8_t> fetchIcon(const std::string& appId, std::optional<int64_t> rev);

    bool isInstalling() const { return installing_; }
    std::string serverAppLatest() const;
    bool canUpdate() const;
    std::string applyUpdate();

private:
    Session() = default;

    mutable std::mutex mutex_;
    std::unique_ptr<ITransport> transport_;
    std::unique_ptr<DeviceApiClient> client_;
    std::unique_ptr<ITransport> pollTransport_;
    std::unique_ptr<DeviceApiClient> pollClient_;
    std::unique_ptr<EventPoller> poller_;
    std::vector<CatalogApp> catalog_;
    std::vector<Job> jobs_;
    std::deque<Job> pending_;
    DeviceState installed_;
    int64_t catalogRev_ = 0;
    std::string serverAppLatest_;
    bool canUpdate_ = false;
    std::string status_;
    JobProgress progress_;
    std::atomic<bool> installing_{false};
    std::atomic<bool> cancel_{false};
    Job currentJob_{};

    void ensureClient();
    void onEvent(const DeviceEvent& ev);
    void enqueueClaimed(Job job);
    void pump();
    void runInstall(Job job);
    void setStatus(std::string s);
    void upsertJob(const Job& job);
};

} // namespace nslib
