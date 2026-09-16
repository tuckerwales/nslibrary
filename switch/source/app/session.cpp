#include "app/session.hpp"

#include "api/url.hpp"
#include "app/services.hpp"
#include "install/engine.hpp"
#include "installed/scanner.hpp"
#include "transport/http.hpp"

#ifdef __SWITCH__
#include "transport/usb.hpp"
#include "ui/progress.hpp"
#include "update/apply.hpp"
#include <borealis.hpp>
#endif

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <thread>

#ifdef __SWITCH__
#include <sys/stat.h>
#endif

namespace nslib {
namespace {

void uiNotify(const std::string& text) {
#ifdef __SWITCH__
    brls::sync([text] { brls::Application::notify(text); });
#else
    (void)text;
#endif
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

void Session::setUrl(std::string url) {
    settings.url = normalizeServerUrl(std::move(url));
    settings.useUsb = false;
    settings.save();
    stop();
    transport_.reset();
    client_.reset();
    pollTransport_.reset();
    pollClient_.reset();
}

void Session::setUsb(bool on) {
    settings.useUsb = on;
    settings.save();
    stop();
    transport_.reset();
    client_.reset();
    pollTransport_.reset();
    pollClient_.reset();
}

void Session::forgetDevice() {
    settings.token.clear();
    settings.save();
    stop();
    transport_.reset();
    client_.reset();
    pollTransport_.reset();
    pollClient_.reset();
}

void Session::ensureClient() {
    if (!transport_ || !client_) {
#ifdef __SWITCH__
        if (settings.useUsb) {
            transport_ = std::make_unique<UsbTransport>();
        } else
#endif
        {
            transport_ = std::make_unique<HttpTransport>(settings.url);
        }
        transport_->setToken(settings.token);
        client_ = std::make_unique<DeviceApiClient>(*transport_, settings.token);
    } else {
        transport_->setToken(settings.token);
        client_->setToken(settings.token);
    }
}

HelloResponse Session::hello() {
    ensureClient();
    auto h = client_->hello();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        serverAppLatest_ = h.appLatest.value_or("");
        canUpdate_ = false;
        for (const auto& cap : h.caps) {
            if (cap == "update") canUpdate_ = true;
        }
    }
    setStatus("Connected to " + h.serverName);
    return h;
}

PairResponse Session::pair(const std::string& code) {
    ensureClient();
    PairRequest req;
    req.code = code;
    req.device = currentDeviceInfo(settings.uuid, settings.name);
    auto res = client_->pair(req);
    settings.token = res.token;
    settings.save();
    transport_->setToken(settings.token);
    client_->setToken(settings.token);
    return res;
}

PairResponse Session::usbHello() {
    setUsb(true);
    ensureClient();
    auto res = client_->usbHello(currentDeviceInfo(settings.uuid, settings.name));
    settings.token = res.token;
    settings.save();
    transport_->setToken(settings.token);
    client_->setToken(settings.token);
    return res;
}

void Session::start() {
    ensureClient();
    hello();
    refreshInstalled();
    refreshCatalog();
    const int wait = settings.useUsb ? 0 : 25;
    if (settings.useUsb) {
        poller_ = std::make_unique<EventPoller>(*client_, [this](const DeviceEvent& ev) { onEvent(ev); }, wait);
    } else {
        pollTransport_ = std::make_unique<HttpTransport>(settings.url);
        pollTransport_->setToken(settings.token);
        pollClient_ = std::make_unique<DeviceApiClient>(*pollTransport_, settings.token);
        poller_ = std::make_unique<EventPoller>(*pollClient_, [this](const DeviceEvent& ev) { onEvent(ev); }, wait);
    }
    poller_->start();
}

void Session::stop() {
    cancel_ = true;
    if (poller_) poller_->stop();
    poller_.reset();
    pollTransport_.reset();
    pollClient_.reset();
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

void Session::refreshCatalog() {
    ensureClient();
    std::vector<CatalogApp> apps;
    std::string cursor;
    int64_t rev = 0;
    bool full = false;
    for (;;) {
        auto page = client_->catalog(-1, cursor, 200);
        rev = page.rev;
        full = page.full;
        apps.insert(apps.end(), page.apps.begin(), page.apps.end());
        if (!page.next) break;
        cursor = *page.next;
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (full || !apps.empty()) catalog_ = std::move(apps);
        catalogRev_ = rev;
        status_ = "Library revision " + std::to_string(catalogRev_);
    }
}

void Session::refreshInstalled() {
    auto state = scanInstalled();
    ensureClient();
    try {
        client_->putState(state);
    } catch (...) {
    }
    std::lock_guard<std::mutex> lock(mutex_);
    installed_ = std::move(state);
}

void Session::queueInstall(int64_t contentMetaId, const std::string& target) {
    ensureClient();
    const std::string t = target.empty() ? settings.defaultTarget : target;
    Job job = client_->createJob(contentMetaId, t);
    {
        std::lock_guard<std::mutex> lock(mutex_);
        upsertJob(job);
    }
    std::thread([this, job]() mutable {
        try {
            job = client_->claimJob(job.id);
        } catch (const ApiError& e) {
            uiNotify(e.what());
            return;
        }
        enqueueClaimed(std::move(job));
    }).detach();
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
        try {
            client_->complete(waiting.id, done);
        } catch (...) {
        }
    }
}

void Session::onEvent(const DeviceEvent& ev) {
    if (ev.t == "catalog") {
        try {
            refreshCatalog();
        } catch (...) {
        }
#ifdef __SWITCH__
        brls::sync([] {});
#endif
        return;
    }
    if (ev.t == "job.queued" && ev.job) {
        Job job = *ev.job;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            upsertJob(job);
        }
        std::thread([this, job]() mutable {
            try {
                job = client_->claimJob(job.id);
            } catch (const ApiError& e) {
                uiNotify(e.what());
                return;
            }
            enqueueClaimed(std::move(job));
        }).detach();
        return;
    }
    if (ev.t == "job.cancel") {
        cancelJob(ev.id);
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
    std::thread([this, next]() {
        runInstall(next);
        {
            std::lock_guard<std::mutex> lock(mutex_);
            installing_ = false;
        }
        pump();
    }).detach();
}

std::vector<uint8_t> Session::fetchIcon(const std::string& appId, std::optional<int64_t> rev) {
    ensureClient();
    return client_->getIcon(appId, rev);
}

std::string Session::serverAppLatest() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return serverAppLatest_;
}

bool Session::canUpdate() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return canUpdate_;
}

#ifdef __SWITCH__
AvailableUpdate Session::checkGithubUpdate() { return fetchSignedUpdate(NSLIB_VERSION); }

void Session::installGithubUpdate(const AvailableUpdate& update) {
    showProgress("Downloading NSLibrary " + update.manifest.version);
    try {
        installSignedNro(update, kSwitchNroPath, [](uint64_t done, uint64_t total) {
            char line[80];
            std::snprintf(line, sizeof(line), "Downloading %llu / %llu",
                static_cast<unsigned long long>(done), static_cast<unsigned long long>(total));
            updateProgress(line);
        });
    } catch (...) {
        hideProgress();
        throw;
    }
    hideProgress();
}
#endif

std::string Session::applyServerUpdate() {
    ensureClient();
    hello();
    if (!canUpdate()) throw std::runtime_error("The library server has no Switch app to download");
#ifdef __SWITCH__
    mkdir("sdmc:/switch", 0777);
    mkdir("sdmc:/switch/nslibrary", 0777);
    const char* part = kSwitchNroPartPath;
    const char* dest = kSwitchNroPath;
    FILE* f = fopen(part, "wb");
    if (!f) throw std::runtime_error("Could not write the update file");
    try {
        client_->getUpdate([&](const uint8_t* p, size_t n) {
            if (fwrite(p, 1, n, f) != n) throw std::runtime_error("Could not write the update file");
        });
    } catch (...) {
        fclose(f);
        remove(part);
        throw;
    }
    fclose(f);
    remove(dest);
    if (rename(part, dest) != 0) {
        remove(part);
        throw std::runtime_error("Could not replace nslibrary.nro");
    }
    return dest;
#else
    throw std::runtime_error("Updates install only on the Switch");
#endif
}

std::string Session::applyUpdate() {
#ifdef __SWITCH__
    const auto found = checkGithubUpdate();
    if (!found.newer) return {};
    installGithubUpdate(found);
    return kSwitchNroPath;
#else
    return applyServerUpdate();
#endif
}

void Session::runInstall(Job job) {
    setStatus("Installing " + job.name);
#ifdef __SWITCH__
    showProgress("Installing " + job.name);
#endif
    uiNotify("Installing " + job.name);

    JobComplete done;
    done.ok = false;
    try {
        auto last = std::chrono::steady_clock::now();
        InstallOptions opt;
        opt.verifyHash = settings.verifyHash;
        InstallEngine engine(*client_, &cancel_, opt);
        engine.install(job, [&](const JobProgress& p) {
            {
                std::lock_guard<std::mutex> lock(mutex_);
                progress_ = p;
            }
            const auto now = std::chrono::steady_clock::now();
            if (now - last >= std::chrono::seconds(1)) {
                last = now;
                try {
                    client_->progress(job.id, p);
                } catch (...) {
                }
            }
            char line[160];
            std::snprintf(line, sizeof(line), "%s %llu / %llu", p.phase.c_str(),
                static_cast<unsigned long long>(p.done), static_cast<unsigned long long>(p.total));
            setStatus(line);
#ifdef __SWITCH__
            updateProgress(line);
#endif
        });
        done.ok = true;
        done.msg = "installed";
        uiNotify("Installed " + job.name);
    } catch (const InstallError& e) {
        done.result = e.result;
        done.msg = e.what();
        if (e.result == "cancelled") uiNotify("Cancelled " + job.name);
        else uiNotify(std::string(e.what()));
    } catch (const std::exception& e) {
        done.msg = e.what();
        uiNotify(e.what());
    }

    try {
        client_->complete(job.id, done);
    } catch (...) {
    }
    try {
        refreshInstalled();
    } catch (...) {
    }
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (auto& j : jobs_) {
            if (j.id == job.id) j.status = done.ok ? "done" : (done.result == "cancelled" ? "cancelled" : "failed");
        }
    }
    setStatus(done.ok ? "Idle" : "Install failed");
#ifdef __SWITCH__
    hideProgress();
#endif
}

} // namespace nslib
