#pragma once

#include "api/client.hpp"
#include "api/protocol.hpp"
#include "app/settings.hpp"
#include "transport/ITransport.hpp"

#ifdef __SWITCH__
#include "saves/console.hpp"
#include "update/apply.hpp"
#endif

#include <atomic>
#include <chrono>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace nslib {

class HttpTransport;

class Session {
public:
    static Session& instance();

    Settings settings;

    bool hasUrl() const { return !settings.url.empty(); }
    bool hasToken() const { return !settings.token.empty(); }

    /** Switch to `url`. A different server drops the token and TLS pin, so the console pairs again. */
    void setUrl(std::string url);
    void setUsb(bool on);
    void forgetDevice();
    PairResponse usbHello();

    HelloResponse hello();
    PairResponse pair(const std::string& code);

    void start();
    void stop();
    bool isReady() const;
    /** True after background calls to the server keep failing; cleared on the next success. */
    bool isOffline() const { return offline_; }
    void setStatus(std::string s);
    void pollEventsOnce();
    void scheduleEvents(long delayMs = kEventIntervalMs);

    std::vector<CatalogApp> catalogSnapshot() const;
    std::vector<Job> jobsSnapshot() const;
    DeviceState installedSnapshot() const;
    std::string status() const;
    JobProgress progressSnapshot() const;
    std::optional<Job> currentJob() const;
    int64_t catalogRev() const;

    void refreshCatalog();
    void refreshInstalled();
    void queueInstall(int64_t contentMetaId, const std::string& target);
    void claimAndInstall(Job job);
    void cancelJob(int64_t jobId);

    std::vector<uint8_t> fetchIcon(const std::string& appId, std::optional<int64_t> rev);

    bool isInstalling() const { return installing_; }
    std::string serverAppLatest() const;
    bool canUpdate() const;
    /** The server stores save backups (it lists `saves` in hello's capabilities). */
    bool supportsSaves() const;
    /** Save backups on the server; `app` empty for every game, `latest` for the newest of each save. */
    std::vector<SaveBackup> listSaveBackups(const std::string& app, bool latest);
#ifdef __SWITCH__
    /** Backs up one save. Runs on the UI thread like installs; refuses while an install is running. */
    SaveBackupResult backupSave(const ConsoleSave& save, const std::string& origin,
        const std::string& unchangedSince = {}, const SaveStepFn& progress = {});
    void restoreSave(const ConsoleSave& save, const SaveBackup& backup, const SaveStepFn& progress = {});
#endif
#ifdef __SWITCH__
    /**
     * Ask the library server for its copy of the app. Its `update.json` must carry the release
     * signature. Throws when the server has no signed app.
     */
    AvailableUpdate checkServerUpdate();
    AvailableUpdate checkGithubUpdate();
    /** Download from wherever `update` came from, check size and SHA-256, and replace this app. */
    void installUpdate(const AvailableUpdate& update);
#endif

    static constexpr long kEventIntervalMs = 1000;
    static constexpr long kMaxEventBackoffMs = 30000;
    /** 200 titles a page: enough for 400k titles, and a hard stop if a server paginates in a loop. */
    static constexpr size_t kMaxCatalogPages = 2000;
    static constexpr int kCatalogAttempts = 3;

private:
    Session() = default;

    mutable std::mutex mutex_;
    std::unique_ptr<ITransport> transport_;
    std::unique_ptr<DeviceApiClient> client_;
    HttpTransport* http_ = nullptr;
    /** Second HTTP handle for progress, events, and cancel while transport_ is busy streaming. */
    std::unique_ptr<HttpTransport> controlTransport_;
    std::unique_ptr<DeviceApiClient> controlClient_;
    std::vector<CatalogApp> catalog_;
    std::vector<Job> jobs_;
    std::deque<Job> pending_;
    std::vector<std::pair<int64_t, JobComplete>> unsentCompletes_;
    DeviceState installed_;
    int64_t catalogRev_ = 0;
    std::string serverAppLatest_;
    bool canUpdate_ = false;
    bool savesCap_ = false;
    std::string status_;
    JobProgress progress_;
    std::atomic<bool> installing_{false};
    std::atomic<bool> cancel_{false};
    std::atomic<bool> updateCancel_{false};
    std::atomic<bool> offline_{false};
    bool starting_ = false;
    bool ready_ = false;
    bool catalogStale_ = false;
    int pollFailures_ = 0;
    uint64_t pollGeneration_ = 0;
    std::chrono::steady_clock::time_point lastSideTick_{};
    std::string eventCursor_;
    Job currentJob_{};

    void resetConnection();
    void ensureClient();
    void learnTlsPinIfNeeded();
    /** Client to use for small calls. During an HTTP install that is the control handle. */
    DeviceApiClient& apiClient();
    void onEvent(const DeviceEvent& ev);
    void enqueueClaimed(Job job);
    void pump();
    void runInstall(Job job);
    void upsertJob(const Job& job);
    void sendComplete(int64_t jobId, const JobComplete& done);
    void flushCompletes(DeviceApiClient& client);
    void sideChannelTick();
    void markOnline();
    void markOffline(const std::string& why);
};

} // namespace nslib
