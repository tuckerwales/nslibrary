#include "ui/progress.hpp"

#include "app/session.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <thread>
#include <borealis.hpp>
#include <borealis/core/font.hpp>
#include <borealis/core/time.hpp>

#ifdef __SWITCH__
#include <switch.h>
#endif

namespace nslib {
namespace {

struct ProgressUi {
    std::string title;
    std::string detail;
    uint64_t done = 0;
    uint64_t total = 0;
    bool visible = false;
    std::chrono::steady_clock::time_point lastPump{};
    bool pumping = false;
    std::thread::id uiThread{};
#ifdef __SWITCH__
    PadState pad{};
    bool padReady = false;
#endif
};

ProgressUi g;

void requestCancel() {
    auto job = Session::instance().currentJob();
    if (job) Session::instance().cancelJob(job->id);
}

void drawOverlay() {
    auto* platform = brls::Application::getPlatform();
    if (!platform) return;
    auto* video = platform->getVideoContext();
    NVGcontext* vg = brls::Application::getNVGContext();
    if (!video || !vg) return;

    const float w = float(brls::Application::windowWidth);
    const float h = float(brls::Application::windowHeight);
    if (w <= 0 || h <= 0) return;

    video->beginFrame();
    video->clear(nvgRGB(18, 18, 22));
    nvgBeginFrame(vg, w, h, video->getScaleFactor());
    nvgScale(vg, brls::Application::windowScale, brls::Application::windowScale);

    const float cw = brls::Application::contentWidth > 0 ? brls::Application::contentWidth : 1280;
    const float ch = brls::Application::contentHeight > 0 ? brls::Application::contentHeight : 720;
    const float cx = cw * 0.5f;
    const float cy = ch * 0.5f;

    nvgFontFaceId(vg, brls::Application::getFont(brls::FONT_REGULAR));
    nvgFontSize(vg, 28);
    nvgTextAlign(vg, NVG_ALIGN_CENTER | NVG_ALIGN_MIDDLE);
    nvgFillColor(vg, nvgRGB(255, 255, 255));
    nvgText(vg, cx, cy - 90, g.title.empty() ? "Installing" : g.title.c_str(), nullptr);

    nvgFontSize(vg, 20);
    nvgFillColor(vg, nvgRGB(200, 200, 200));
    nvgText(vg, cx, cy - 44, g.detail.empty() ? "…" : g.detail.c_str(), nullptr);

    const float barw = 640;
    const float barh = 18;
    const float barx = cx - barw * 0.5f;
    const float bary = cy + 8;
    nvgBeginPath(vg);
    nvgRoundedRect(vg, barx, bary, barw, barh, 4);
    nvgFillColor(vg, nvgRGB(48, 48, 56));
    nvgFill(vg);

    float ratio = 0;
    if (g.total > 0) ratio = std::min(1.f, float(double(g.done) / double(g.total)));
    if (ratio > 0) {
        nvgBeginPath(vg);
        nvgRoundedRect(vg, barx, bary, barw * ratio, barh, 4);
        nvgFillColor(vg, nvgRGB(0, 186, 163));
        nvgFill(vg);
    }

    if (g.total > 0) {
        char pct[32];
        std::snprintf(pct, sizeof(pct), "%.0f%%", double(ratio) * 100.0);
        nvgFontSize(vg, 18);
        nvgFillColor(vg, nvgRGB(220, 220, 220));
        nvgText(vg, cx, cy + 48, pct, nullptr);
    }

    nvgFontSize(vg, 18);
    nvgFillColor(vg, nvgRGB(160, 160, 160));
    nvgText(vg, cx, cy + 84, "Press B to cancel", nullptr);

    nvgEndFrame(vg);
    video->endFrame();
}

} // namespace

void pumpProgressUi(bool force) {
    if (g.uiThread != std::thread::id() && std::this_thread::get_id() != g.uiThread) return;
    if (!g.visible) return;
    if (g.pumping) return;
    const auto now = std::chrono::steady_clock::now();
    if (!force && g.lastPump.time_since_epoch().count() != 0 &&
        now - g.lastPump < std::chrono::milliseconds(50))
        return;
    g.lastPump = now;
    g.pumping = true;

    auto p = Session::instance().progressSnapshot();
    if (!p.phase.empty()) {
        char line[160];
        std::snprintf(line, sizeof(line), "%s  %llu / %llu", p.phase.c_str(),
            static_cast<unsigned long long>(p.done), static_cast<unsigned long long>(p.total));
        g.detail = line;
        g.done = p.done;
        g.total = p.total;
    }

#ifdef __SWITCH__
    if (!g.padReady) {
        padInitializeDefault(&g.pad);
        g.padReady = true;
    }
    padUpdate(&g.pad);
    if (padGetButtonsDown(&g.pad) & HidNpadButton_B) requestCancel();
#endif

    auto* platform = brls::Application::getPlatform();
    if (platform && !platform->mainLoopIteration()) {
        requestCancel();
        brls::Application::quit();
    }
    brls::Ticking::updateTickings();
    drawOverlay();
    g.pumping = false;
}

void showProgress(const std::string& title) {
    g.uiThread = std::this_thread::get_id();
    g.visible = true;
    g.title = title;
    g.detail = "Starting…";
    g.done = 0;
    g.total = 0;
    pumpProgressUi(true);
}

void updateProgress(const std::string& line, uint64_t done, uint64_t total) {
    if (g.uiThread != std::thread::id() && std::this_thread::get_id() != g.uiThread) return;
    g.detail = line;
    g.done = done;
    g.total = total;
    pumpProgressUi();
}

void hideProgress() {
    g.visible = false;
    g.title.clear();
    g.detail.clear();
    g.done = 0;
    g.total = 0;
}

} // namespace nslib
