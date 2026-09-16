#include "app/session.hpp"

#include "api/url.hpp"
#include "app/services.hpp"
#include "install/engine.hpp"
#include "installed/scanner.hpp"

#ifdef __SWITCH__
#include "ui/progress.hpp"
#include <borealis.hpp>
#endif

#include <chrono>
#include <cstdio>
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

} // namespace

Session& Session::instance() {
    static Session s;
    return s;
}

void Session::setStatus(std::string s) {
    std::lock_guard<std::mutex> lock(mutex_);
    status_ = std::move(s);
}

void Session::setUrl(std::string url) {
    settings.url = normalizeServerUrl(std::move(url));
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
        transport_ = std::make_unique<HttpTransport>(settings.url);
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

void Session::start() {
    ensureClient();
    hello();
    refreshInstalled();
    refreshCatalog();
    pollTransport_ = std::make_unique<HttpTransport>(settings.url);
    pollTransport_->setToken(settings.token);
    pollClient_ = std::make_unique<DeviceApiClient>(*pollTransport_, settings.token);
    poller_ = std::make_unique<EventPoller>(*pollClient_, [this](const DeviceEvent& ev) { onEvent(ev); });
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
    Job job = client_->createJob(contentMetaId, target);
    {
        std::lock_guard<std::mutex> lock(mutex_);
        jobs_.push_back(job);
    }
    std::thread([this, job]() mutable {
        try {
            job = client_->claimJob(job.id);
        } catch (...) {
        }
        runInstall(std::move(job));
    }).detach();
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
            jobs_.push_back(job);
        }
        std::thread([this, job]() mutable {
            try {
                job = client_->claimJob(job.id);
            } catch (const ApiError& e) {
                uiNotify(e.what());
                return;
            }
            runInstall(std::move(job));
        }).detach();
        return;
    }
    if (ev.t == "job.cancel") {
        if (currentJob_.id == ev.id) cancel_ = true;
    }
}

void Session::runInstall(Job job) {
    if (installing_.exchange(true)) {
        uiNotify("Already installing; wait for the current job");
        return;
    }
    currentJob_ = job;
    cancel_ = false;
    setStatus("Installing " + job.name);
#ifdef __SWITCH__
    showProgress("Installing " + job.name);
#endif
    uiNotify("Installing " + job.name);

    JobComplete done;
    done.ok = false;
    try {
        auto last = std::chrono::steady_clock::now();
        InstallEngine engine(*client_, &cancel_);
        engine.install(job, [&](const JobProgress& p) {
            const auto now = std::chrono::steady_clock::now();
            if (now - last >= std::chrono::seconds(1)) {
                last = now;
                try {
                    client_->progress(job.id, p);
                } catch (...) {
                }
            }
            char line[128];
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
        uiNotify(std::string(e.what()));
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
    installing_ = false;
    setStatus(done.ok ? "Idle" : "Install failed");
#ifdef __SWITCH__
    hideProgress();
#endif
}

} // namespace nslib
