#include "app/session.hpp"

#include "api/url.hpp"
#include "app/services.hpp"
#include "install/engine.hpp"
#include "installed/scanner.hpp"
#include "transport/http.hpp"
#include "transport/resume.hpp"
#include "ui/format.hpp"

#ifdef __SWITCH__
#include "transport/usb.hpp"
#include "ui/main_activity.hpp"
#include "ui/progress.hpp"
#include "update/apply.hpp"
#include <borealis.hpp>
#endif

#include <algorithm>
#include <chrono>
#include <thread>

namespace nslib {
namespace {

void uiNotify(const std::string& text) {
#ifdef __SWITCH__
    brls::sync([text] { brls::Application::notify(text); });
#else
    (void)text;
#endif
}

/** Translated UI text. Only the Switch build has Borealis, so host builds keep the raw argument. */
std::string uiText(const std::string& key, const std::string& arg = "") {
#ifdef __SWITCH__
    if (key.empty()) return arg;
    return arg.empty() ? brls::getStr(key) : brls::getStr(key, arg);
#else
    (void)key;
    return arg;
#endif
}

void refreshTabsLater() {
#ifdef __SWITCH__
    brls::sync([] { refreshVisibleTabs(); });
#endif
}

/** "Copying content   48%   10.8 GB / 22.5 GB" for the queue tab and the status line. */
std::string formatProgressLine(const JobProgress& p) {
    std::string line = uiText(installPhaseKey(p.phase), p.phase);
    const std::string pct = formatPercent(p.done, p.total);
    if (!pct.empty()) line += "   " + pct;
    if (p.total) line += "   " + formatOfTotal(p.done, p.total);
    return line;
}

} // namespace

Session& Session::instance() {
    static Session s;
    return s;
}

void Session::setStatus(std::string s) {
    std::lock_guard<std::mutex> lock(mutex_);
    status_ = std::move(s);
}

void Session::upsertJob(const Job& job) {
    for (auto& j : jobs_) {
        if (j.id == job.id) {
            j = job;
            return;
        }
    }
    jobs_.push_back(job);
}

void Session::resetConnection() {
    stop();
#ifdef __SWITCH__
    setProgressTick(nullptr);
#endif
    client_.reset();
    transport_.reset();
    http_ = nullptr;
    controlClient_.reset();
    controlTransport_.reset();
    std::lock_guard<std::mutex> lock(mutex_);
    ready_ = false;
    starting_ = false;
}

void Session::setUrl(std::string url) {
    const std::string normalized = normalizeServerUrl(std::move(url));
    if (normalized != settings.url) {
        // A token and certificate pin belong to one server.
        settings.token.clear();
        settings.tlsPin.clear();
    }
    settings.url = normalized;
    settings.useUsb = false;
    settings.save();
    resetConnection();
}

void Session::setUsb(bool on) {
    settings.useUsb = on;
    settings.save();
    resetConnection();
}

void Session::forgetDevice() {
    settings.token.clear();
    settings.tlsPin.clear();
    settings.save();
    resetConnection();
}

void Session::ensureClient() {
    if (!transport_ || !client_) {
#ifdef __SWITCH__
        if (settings.useUsb) {
            auto usb = std::make_unique<UsbTransport>();
            usb->setChunkBoundaryHook([this] { sideChannelTick(); });
            transport_ = std::move(usb);
        } else
#endif
        {
            auto http = std::make_unique<HttpTransport>(settings.url);
            http->setPinnedPublicKey(settings.tlsPin);
            http_ = http.get();
            transport_ = std::move(http);

            controlTransport_ = std::make_unique<HttpTransport>(settings.url);
            controlTransport_->setPinnedPublicKey(settings.tlsPin);
            controlTransport_->setToken(settings.token);
            controlClient_ = std::make_unique<DeviceApiClient>(*controlTransport_, settings.token);
#ifdef __SWITCH__
            setProgressTick([this] { sideChannelTick(); });
#endif
        }
        transport_->setToken(settings.token);
        client_ = std::make_unique<DeviceApiClient>(*transport_, settings.token);
    } else {
        transport_->setToken(settings.token);
        client_->setToken(settings.token);
        if (controlTransport_) {
            controlTransport_->setToken(settings.token);
            controlClient_->setToken(settings.token);
        }
    }
}

void Session::learnTlsPinIfNeeded() {
    if (!http_ || !http_->isHttps() || !settings.tlsPin.empty()) return;
    // Trust on first use: remember the server's public key and refuse a different one later.
    const auto pin = http_->fetchPublicKeyPin();
    if (!pin) {
        brls::Logger::warning("TLS: could not read the server certificate; the connection is not pinned");
        return;
    }
    settings.tlsPin = *pin;
    settings.save();
    http_->setPinnedPublicKey(*pin);
    if (controlTransport_) controlTransport_->setPinnedPublicKey(*pin);
    brls::Logger::info("TLS: pinned server key {}", *pin);
}

DeviceApiClient& Session::apiClient() {
    ensureClient();
    if (installing_ && controlClient_) return *controlClient_;
    return *client_;
}

HelloResponse Session::hello() {
    brls::Logger::info("hello begin");
    ensureClient();
    learnTlsPinIfNeeded();
    auto h = client_->hello();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        serverAppLatest_ = h.appLatest.value_or("");
        canUpdate_ = false;
        savesCap_ = false;
        for (const auto& cap : h.caps) {
            if (cap == "update") canUpdate_ = true;
            if (cap == "saves") savesCap_ = true;
        }
    }
    markOnline();
    setStatus("Connected to " + h.serverName);
    brls::Logger::info("hello ok server={} rev={}", h.serverName, h.catalogRev);
    return h;
}

PairResponse Session::pair(const std::string& code) {
    brls::Logger::info("pair begin");
    ensureClient();
    learnTlsPinIfNeeded();
    PairRequest req;
    req.code = code;
    req.device = currentDeviceInfo(settings.uuid, settings.name);
    auto res = client_->pair(req);
    settings.token = res.token;
    settings.save();
    ensureClient();
    brls::Logger::info("pair ok server={}", res.serverName);
    return res;
}

PairResponse Session::usbHello() {
    setUsb(true);
    ensureClient();
    auto res = client_->usbHello(currentDeviceInfo(settings.uuid, settings.name));
    settings.token = res.token;
    settings.save();
    ensureClient();
    return res;
}

void Session::start() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (ready_ || starting_) return;
        starting_ = true;
    }
    try {
        brls::Logger::info("session start");
        ensureClient();
        hello();
        refreshCatalog();
        {
            std::lock_guard<std::mutex> lock(mutex_);
            ready_ = true;
            starting_ = false;
            pollFailures_ = 0;
        }
        brls::Logger::info("session ready, scheduling events");
        scheduleEvents();
    } catch (...) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            ready_ = false;
            starting_ = false;
        }
        brls::Logger::error("session start failed");
        throw;
    }
}

void Session::stop() {
    cancel_ = true;
    std::lock_guard<std::mutex> lock(mutex_);
    ready_ = false;
    starting_ = false;
    eventCursor_.clear();
    pollGeneration_++;
}

bool Session::isReady() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return ready_;
}

void Session::markOnline() {
    if (offline_.exchange(false)) {
        brls::Logger::info("library reachable again");
        refreshTabsLater();
    }
    pollFailures_ = 0;
}

void Session::markOffline(const std::string& why) {
    if (!offline_.exchange(true)) {
        brls::Logger::warning("library unreachable: {}", why);
        uiNotify(uiText("app/connect/offline"));
        refreshTabsLater();
    }
}

void Session::pollEventsOnce() {
    ensureClient();
    auto& client = apiClient();
    auto page = client.events(eventCursor_, 0);
    eventCursor_ = page.cursor;
    markOnline();
    if (!page.ev.empty()) brls::Logger::info("events n={} cursor={}", page.ev.size(), eventCursor_);
    for (const auto& ev : page.ev) {
        brls::Logger::info("event t={}", ev.t);
        onEvent(ev);
    }
    flushCompletes(client);
}

void Session::scheduleEvents(long delayMs) {
#ifdef __SWITCH__
    uint64_t generation = 0;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        generation = pollGeneration_;
    }
    brls::delay(delayMs, [generation] {
        auto& session = Session::instance();
        {
            std::lock_guard<std::mutex> lock(session.mutex_);
            if (!session.ready_ || generation != session.pollGeneration_) return;
        }
        long next = kEventIntervalMs;
        try {
            session.pollEventsOnce();
        } catch (const ApiError& e) {
            brls::Logger::error("events poll: {}", e.what());
            if (e.code == "UNAUTHORIZED" || e.code == "DEVICE_REVOKED") {
                const std::string msg = e.what();
                session.forgetDevice();
                showScreen(Screen::Pair, [msg] { showError(msg); });
                return;
            }
            next = kEventIntervalMs * 5;
        } catch (const std::exception& e) {
            // Unreachable server: back off so blocking connects do not freeze the UI every second.
            session.pollFailures_++;
            session.markOffline(e.what());
            next = std::min<long>(kMaxEventBackoffMs, 2000L << std::min(session.pollFailures_ - 1, 4));
            brls::Logger::error("events poll: {} (retry in {} ms)", e.what(), next);
        } catch (...) {
            brls::Logger::error("events poll: unknown");
            next = kEventIntervalMs * 5;
        }
        session.scheduleEvents(next);
    });
#else
    (void)delayMs;
#endif
}

std::vector<CatalogApp> Session::catalogSnapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return catalog_;
}

std::vector<Job> Session::jobsSnapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return jobs_;
}

DeviceState Session::installedSnapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return installed_;
}

std::string Session::status() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return status_;
}

JobProgress Session::progressSnapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return progress_;
}

std::optional<Job> Session::currentJob() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!installing_) return std::nullopt;
    return currentJob_;
}

int64_t Session::catalogRev() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return catalogRev_;
}

void Session::refreshCatalog() {
    brls::Logger::info("catalog begin");
    ensureClient();
    std::vector<CatalogApp> apps;
    int64_t rev = 0;
    bool full = false;
    size_t skipped = 0;
    // Pages fetched while the library changes can mix two revisions. Start over when that happens,
    // and if it keeps happening, remember the oldest revision so the next catalog event refetches.
    for (int attempt = 0; attempt < kCatalogAttempts; attempt++) {
        apps.clear();
        skipped = 0;
        full = false;
        std::string cursor;
        // A server that keeps handing back the same cursor would loop here forever.
        std::string lastCursor;
        int64_t firstRev = -1;
        bool mixed = false;
        for (size_t pageIndex = 0; pageIndex < kMaxCatalogPages; pageIndex++) {
            auto page = client_->catalog(-1, cursor, 200);
            if (firstRev < 0) firstRev = page.rev;
            if (page.rev != firstRev) mixed = true;
            rev = std::min(firstRev, page.rev);
            full = page.full;
            skipped += page.skipped;
            apps.insert(apps.end(), page.apps.begin(), page.apps.end());
            if (!page.next) break;
            if (*page.next == cursor || *page.next == lastCursor) {
                brls::Logger::warning("catalog: server repeated cursor {}, stopping", *page.next);
                break;
            }
            lastCursor = cursor;
            cursor = *page.next;
        }
        if (!mixed) break;
        brls::Logger::warning("catalog: library changed while paging (attempt {})", attempt + 1);
    }
    size_t count = 0;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (full || !apps.empty()) catalog_ = std::move(apps);
        catalogRev_ = rev;
        catalogStale_ = false;
        status_ = "Library revision " + std::to_string(catalogRev_);
        count = catalog_.size();
    }
    if (skipped) brls::Logger::warning("catalog: skipped {} title(s) this client could not read", skipped);
    brls::Logger::info("catalog ok apps={} rev={}", count, rev);
}

void Session::refreshInstalled() {
    brls::Logger::info("scan installed begin");
    DeviceState state;
    try {
        state = scanInstalled();
    } catch (...) {
        brls::Logger::error("scan installed threw");
        state.fw = firmwareVersion();
        state.ams = atmosphereVersion();
    }
    brls::Logger::info("scan installed titles={}", state.titles.size());
    {
        std::lock_guard<std::mutex> lock(mutex_);
        installed_ = state;
    }
    try {
        apiClient().putState(state);
    } catch (const std::exception& e) {
        brls::Logger::error("put state: {}", e.what());
    }
}

void Session::queueInstall(int64_t contentMetaId, const std::string& target) {
    ensureClient();
    const std::string t = target.empty() ? settings.defaultTarget : target;
    try {
        Job job = apiClient().createJob(contentMetaId, t);
        {
            std::lock_guard<std::mutex> lock(mutex_);
            upsertJob(job);
        }
        job = apiClient().claimJob(job.id);
        enqueueClaimed(std::move(job));
    } catch (const std::exception& e) {
        brls::Logger::error("queue install: {}", e.what());
        uiNotify(e.what());
    }
}

void Session::sendComplete(int64_t jobId, const JobComplete& done) {
    try {
        apiClient().complete(jobId, done);
    } catch (const ApiError& e) {
        // The server rejected it (job gone, already finished). Retrying will not help.
        brls::Logger::error("complete job {}: {}", jobId, e.what());
    } catch (const std::exception& e) {
        brls::Logger::error("complete job {}: {} (will retry)", jobId, e.what());
        std::lock_guard<std::mutex> lock(mutex_);
        unsentCompletes_.emplace_back(jobId, done);
    }
}

void Session::flushCompletes(DeviceApiClient& client) {
    std::vector<std::pair<int64_t, JobComplete>> todo;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        todo.swap(unsentCompletes_);
    }
    for (size_t i = 0; i < todo.size(); i++) {
        try {
            client.complete(todo[i].first, todo[i].second);
            brls::Logger::info("complete job {} sent after retry", todo[i].first);
        } catch (const ApiError& e) {
            brls::Logger::error("complete job {}: {}", todo[i].first, e.what());
        } catch (const std::exception&) {
            std::lock_guard<std::mutex> lock(mutex_);
            unsentCompletes_.insert(unsentCompletes_.end(), todo.begin() + long(i), todo.end());
            return;
        }
    }
}

void Session::cancelJob(int64_t jobId) {
    bool current = false;
    Job waiting;
    bool hadWaiting = false;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (installing_ && currentJob_.id == jobId) {
            current = true;
            cancel_ = true;
        }
        auto it = std::find_if(pending_.begin(), pending_.end(), [&](const Job& j) { return j.id == jobId; });
        if (it != pending_.end()) {
            waiting = *it;
            hadWaiting = true;
            pending_.erase(it);
        }
        for (auto& j : jobs_) {
            if (j.id == jobId) j.status = "cancelled";
        }
    }
    if (current) {
        uiNotify("Cancelling install");
        if (transport_) transport_->abort();
    }
    if (hadWaiting) {
        JobComplete done;
        done.ok = false;
        done.result = "cancelled";
        done.msg = "cancelled";
        sendComplete(waiting.id, done);
    }
    refreshTabsLater();
}

void Session::onEvent(const DeviceEvent& ev) {
    if (ev.t == "catalog") {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (ev.rev == catalogRev_) return;
            if (installing_) {
                // transport_ is busy streaming; fetch the catalog when the install ends.
                catalogStale_ = true;
                return;
            }
        }
        try {
            refreshCatalog();
        } catch (const std::exception& e) {
            brls::Logger::error("catalog refresh: {}", e.what());
        }
        refreshTabsLater();
        return;
    }
    if (ev.t == "job.queued" && ev.job) {
        claimAndInstall(*ev.job);
        return;
    }
    if (ev.t == "job.cancel") {
        cancelJob(ev.id);
    }
}

void Session::claimAndInstall(Job job) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        upsertJob(job);
        if (installing_ && currentJob_.id == job.id) return;
        for (const auto& p : pending_) {
            if (p.id == job.id) return;
        }
    }
    try {
        brls::Logger::info("claim job {} {}", job.id, job.name);
        if (job.status == "queued" || job.status == "interrupted" || job.status.empty()) {
            job = apiClient().claimJob(job.id);
        }
        enqueueClaimed(std::move(job));
        refreshTabsLater();
    } catch (const std::exception& e) {
        brls::Logger::error("claim job {}: {}", job.id, e.what());
        uiNotify(e.what());
    }
}

void Session::enqueueClaimed(Job job) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        job.status = "claimed";
        upsertJob(job);
        pending_.push_back(std::move(job));
    }
    pump();
}

void Session::pump() {
    Job next;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (installing_ || pending_.empty()) return;
        next = pending_.front();
        pending_.pop_front();
        installing_ = true;
        currentJob_ = next;
        cancel_ = false;
    }
    // Transports keep an abort until it is cleared here, so a cancel can never leak into the next job.
    if (transport_) transport_->clearAbort();
    if (controlTransport_) controlTransport_->clearAbort();
#ifdef __SWITCH__
    brls::Logger::info("install schedule {}", next.name);
    brls::delay(0, [this, next]() {
        brls::Logger::info("install run {}", next.name);
        runInstall(next);
        {
            std::lock_guard<std::mutex> lock(mutex_);
            installing_ = false;
        }
        brls::Logger::info("install done {}", next.name);
        bool stale = false;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stale = catalogStale_;
        }
        if (stale) {
            try {
                refreshCatalog();
            } catch (const std::exception& e) {
                brls::Logger::error("catalog refresh: {}", e.what());
            }
        }
        refreshVisibleTabs();
        pump();
    });
#else
    std::thread([this, next]() {
        runInstall(next);
        {
            std::lock_guard<std::mutex> lock(mutex_);
            installing_ = false;
        }
        pump();
    }).detach();
#endif
}

void Session::sideChannelTick() {
    if (!installing_) return;
    const auto now = std::chrono::steady_clock::now();
    // After failures, wait longer so a dead control channel does not slow the download.
    const auto interval = std::chrono::seconds(pollFailures_ > 0 ? std::min(30, 2 << std::min(pollFailures_, 4)) : 2);
    if (lastSideTick_.time_since_epoch().count() != 0 && now - lastSideTick_ < interval) return;
    lastSideTick_ = now;

    Job job;
    JobProgress progress;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        job = currentJob_;
        progress = progress_;
    }
    auto& client = apiClient();
    try {
        if (!progress.phase.empty()) client.progress(job.id, progress);
        auto page = client.events(eventCursor_, 0);
        eventCursor_ = page.cursor;
        markOnline();
        for (const auto& ev : page.ev) {
            brls::Logger::info("event (install) t={}", ev.t);
            onEvent(ev);
        }
        flushCompletes(client);
    } catch (const std::exception& e) {
        pollFailures_++;
        brls::Logger::error("install side channel: {}", e.what());
    }
}

std::vector<uint8_t> Session::fetchIcon(const std::string& appId, std::optional<int64_t> rev) {
    return apiClient().getIcon(appId, rev);
}

std::string Session::serverAppLatest() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return serverAppLatest_;
}

bool Session::supportsSaves() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return savesCap_;
}

std::vector<SaveBackup> Session::listSaveBackups(const std::string& app, bool latest) {
    ensureClient();
    return apiClient().listSaves(app, latest);
}

#ifdef __SWITCH__
SaveBackupResult Session::backupSave(const ConsoleSave& save, const std::string& origin,
    const std::string& unchangedSince, const SaveStepFn& progress)
{
    if (installing_) throw std::runtime_error(uiText("app/saves/busy"));
    ensureClient();
    if (transport_) transport_->clearAbort();
    return backupConsoleSave(save, origin, *client_, unchangedSince, progress);
}

void Session::restoreSave(const ConsoleSave& save, const SaveBackup& backup, const SaveStepFn& progress) {
    if (installing_) throw std::runtime_error(uiText("app/saves/busy"));
    ensureClient();
    if (transport_) transport_->clearAbort();
    restoreConsoleSave(save, backup, *client_, progress);
}

void Session::abortSaveTransfer() {
    // The next backup or restore clears it again, as the next install does.
    if (transport_) transport_->abort();
}
#endif

bool Session::canUpdate() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return canUpdate_;
}

#ifdef __SWITCH__
AvailableUpdate Session::checkServerUpdate() {
    ensureClient();
    updateCancel_ = false;
    if (transport_) transport_->clearAbort();
    showProgress(uiText("app/settings/update_check_server"), [this] {
        updateCancel_ = true;
        if (transport_) transport_->abort();
    });
    try {
        hello();
        if (!canUpdate()) throw std::runtime_error("The library server has no signed Switch app to download");
        // The server copy is only trusted if its update.json carries the release signature.
        const auto manifestBytes = client_->getUpdateManifest();
        const auto sigBytes = client_->getUpdateSignature();
        if (updateCancel_) throw std::runtime_error("cancelled");
        AvailableUpdate found;
        found.fromServer = true;
        found.manifest = verifySignedManifest(
            manifestBytes.data(), manifestBytes.size(), sigBytes.data(), sigBytes.size(), updatePublicKey());
        found.newer = cmpVersion(found.manifest.version, NSLIB_VERSION) > 0;
        hideProgress();
        return found;
    } catch (...) {
        hideProgress();
        if (updateCancel_) throw std::runtime_error("cancelled");
        throw;
    }
}

AvailableUpdate Session::checkGithubUpdate() {
    updateCancel_ = false;
    showProgress(uiText("app/settings/update_check_github"), [this] { updateCancel_ = true; });
    try {
        auto found = fetchSignedUpdate(NSLIB_VERSION, &updateCancel_);
        hideProgress();
        return found;
    } catch (...) {
        hideProgress();
        throw;
    }
}

void Session::installUpdate(const AvailableUpdate& update) {
    const auto progress = [](uint64_t done, uint64_t total) {
        updateProgress(formatOfTotal(done, total), done, total);
    };
    updateCancel_ = false;
    if (!update.fromServer) {
        showProgress(uiText("app/settings/update_downloading", update.manifest.version),
            [this] { updateCancel_ = true; });
        try {
            installSignedNro(update, kSwitchNroPath, progress, &updateCancel_);
        } catch (...) {
            hideProgress();
            throw;
        }
        hideProgress();
        return;
    }

    ensureClient();
    if (transport_) transport_->clearAbort();
    showProgress(uiText("app/settings/update_downloading_server", update.manifest.version), [this] {
        updateCancel_ = true;
        if (transport_) transport_->abort();
    });
    try {
        std::vector<uint8_t> nro;
        nro.reserve(size_t(update.manifest.size));
        client_->getUpdate([&](const uint8_t* p, size_t n) {
            if (updateCancel_) throw std::runtime_error("cancelled");
            if (nro.size() + n > kMaxUpdateNroBytes) throw std::runtime_error("update is larger than 32 MB");
            nro.insert(nro.end(), p, p + n);
            progress(nro.size(), update.manifest.size);
        });
        installVerifiedNro(update.manifest, nro, kSwitchNroPath);
    } catch (...) {
        hideProgress();
        if (updateCancel_) throw std::runtime_error("cancelled");
        throw;
    }
    hideProgress();
}
#endif

void Session::runInstall(Job job) {
    const std::string shown = cleanTitleName(job.name);
    setStatus(uiText("app/notify/installing", shown));
#ifdef __SWITCH__
    showProgress(uiText("app/notify/installing", shown));
#endif

    JobComplete done;
    done.ok = false;
    try {
        brls::Logger::info("install engine {}", job.name);
        InstallOptions opt;
        opt.verifyHash = settings.verifyHash;
        opt.clearFirmwareRequirement = settings.clearFirmwareRequirement;
#ifdef __SWITCH__
        opt.warn = [](const std::string& text) { setProgressWarning(text); };
#endif
        InstallEngine engine(*client_, &cancel_, opt);
        engine.install(job, [&](const JobProgress& p) {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                progress_ = p;
            }
            const std::string line = formatProgressLine(p);
            setStatus(line);
#ifdef __SWITCH__
            updateProgress(line, p.done, p.total);
#endif
        });
        done.ok = true;
        done.msg = "installed";
        brls::Logger::info("install engine ok {}", job.name);
    } catch (const InstallError& e) {
        brls::Logger::error("install engine: {}", e.what());
        done.result = e.result;
        done.msg = e.what();
    } catch (const std::exception& e) {
        brls::Logger::error("install engine: {}", e.what());
        done.msg = e.what();
        if (cancel_ || std::string(e.what()) == "cancelled") {
            done.result = "cancelled";
            done.msg = "cancelled";
        }
    }
    const bool cancelled = done.result && *done.result == "cancelled";

    sendComplete(job.id, done);
    try {
        refreshInstalled();
    } catch (...) {
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (auto& j : jobs_) {
            if (j.id == job.id) j.status = done.ok ? "done" : (cancelled ? "cancelled" : "failed");
        }
        progress_ = JobProgress{};
    }
    setStatus(done.ok ? "Idle" : (cancelled ? "Install cancelled" : "Install failed"));
#ifdef __SWITCH__
    // The progress screen reports the outcome. A cancel needs no report: the user asked for it.
    if (done.ok) showProgressResult(true, uiText("app/notify/installed", shown));
    else if (!cancelled) showProgressResult(false, uiText("app/progress/failed", shown), done.msg.value_or(""));
    hideProgress();
#endif
}

} // namespace nslib
