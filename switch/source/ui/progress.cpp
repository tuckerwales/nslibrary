#include "ui/progress.hpp"

#include "app/session.hpp"
#include "ui/format.hpp"
#include "ui/widgets.hpp"

#include <algorithm>
#include <chrono>
#include <thread>
#include <borealis.hpp>
#include <borealis/core/font.hpp>
#include <borealis/core/time.hpp>

#ifdef __SWITCH__
#include <switch.h>
#endif

using namespace brls::literals;

namespace nslib {
namespace {

struct ProgressUi {
    std::string title;
    std::string detail;
    std::string warning;
    double bps = 0;
    std::function<void()> onCancel;
    std::function<void()> tick;
    std::chrono::steady_clock::time_point lastTick{};
    bool ticking = false;
    uint64_t done = 0;
    uint64_t total = 0;
    bool visible = false;
    enum class Result { None, Ok, Failed } result = Result::None;
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
    if (g.onCancel) {
        g.onCancel();
        return;
    }
    auto job = Session::instance().currentJob();
    if (job) Session::instance().cancelJob(job->id);
}

void runProgressTick(std::chrono::steady_clock::time_point now) {
    if (!g.tick || g.ticking) return;
    if (g.lastTick.time_since_epoch().count() != 0 && now - g.lastTick < std::chrono::seconds(2)) return;
    g.lastTick = now;
    g.ticking = true;
    try {
        g.tick();
    } catch (const std::exception& e) {
        brls::Logger::error("progress tick: {}", e.what());
    } catch (...) {
        brls::Logger::error("progress tick: unknown");
    }
    g.ticking = false;
}

void drawText(NVGcontext* vg, float x, float y, float size, NVGcolor color, int align, const std::string& text) {
    if (text.empty()) return;
    nvgFontSize(vg, size);
    nvgTextAlign(vg, align);
    nvgFillColor(vg, color);
    nvgText(vg, x, y, text.c_str(), nullptr);
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

    const NVGcolor white = nvgRGB(255, 255, 255);
    const NVGcolor grey = nvgRGB(170, 170, 176);
    const NVGcolor accent = nvgRGB(0, 186, 163);
    const int center = NVG_ALIGN_CENTER | NVG_ALIGN_MIDDLE;

    nvgFontFaceId(vg, brls::Application::getFont(brls::FONT_REGULAR));
    drawText(vg, cx, cy - 120, 28, white, center, g.title.empty() ? "app/progress/installing"_i18n : g.title);

    if (g.result == ProgressUi::Result::Failed) {
        // Install errors can run long, so wrap them instead of drawing one clipped line.
        const float boxw = 760;
        nvgFontSize(vg, 20);
        nvgFillColor(vg, nvgRGB(255, 120, 110));
        nvgTextAlign(vg, NVG_ALIGN_CENTER | NVG_ALIGN_TOP);
        nvgTextBox(vg, cx - boxw * 0.5f, cy - 90, boxw, g.detail.c_str(), nullptr);
        drawText(vg, cx, ch - 60, 18, grey, center, "app/progress/continue_hint"_i18n);
        nvgEndFrame(vg);
        video->endFrame();
        return;
    }

    drawText(vg, cx, cy - 78, 20, grey, center, g.detail);

    const float barw = 760;
    const float barh = 22;
    const float barx = cx - barw * 0.5f;
    const float bary = cy - 30;
    nvgBeginPath(vg);
    nvgRoundedRect(vg, barx, bary, barw, barh, barh * 0.5f);
    nvgFillColor(vg, nvgRGB(46, 46, 54));
    nvgFill(vg);

    float ratio = 0;
    if (g.total > 0) ratio = std::min(1.f, float(double(g.done) / double(g.total)));
    if (ratio > 0) {
        // Never narrower than the rounded cap, so 1% still looks like a bar rather than a sliver.
        const float fill = std::max(barh, barw * ratio);
        nvgBeginPath(vg);
        nvgRoundedRect(vg, barx, bary, fill, barh, barh * 0.5f);
        nvgFillColor(vg, accent);
        nvgFill(vg);
    }

    const float under = bary + barh + 24;
    const std::string amount = (g.done || g.total) ? formatOfTotal(g.done, g.total) : std::string();
    drawText(vg, barx, under, 18, grey, NVG_ALIGN_LEFT | NVG_ALIGN_MIDDLE, amount);
    drawText(vg, barx + barw, under, 18, white, NVG_ALIGN_RIGHT | NVG_ALIGN_MIDDLE, formatPercent(g.done, g.total));

    std::string pace = formatRate(g.bps);
    const std::string eta = g.total > g.done ? formatEta(double(g.total - g.done), g.bps) : std::string();
    if (!eta.empty()) pace += (pace.empty() ? "" : "   ") + brls::getStr("app/queue/left", eta);
    drawText(vg, cx, under + 36, 18, grey, center, pace);

    drawText(vg, cx, under + 78, 18, nvgRGB(255, 196, 0), center, g.warning);
    drawText(vg, cx, ch - 60, 18, grey, center,
             g.result == ProgressUi::Result::Ok ? "app/progress/continue_hint"_i18n : "app/progress/cancel_hint"_i18n);

    nvgEndFrame(vg);
    video->endFrame();
}

} // namespace

void pumpProgressUi(bool force, bool runTick) {
    if (g.uiThread != std::thread::id() && std::this_thread::get_id() != g.uiThread) return;
    if (!g.visible) return;
    if (g.pumping || g.ticking) return;
    const auto now = std::chrono::steady_clock::now();
    if (!force && g.lastPump.time_since_epoch().count() != 0 &&
        now - g.lastPump < std::chrono::milliseconds(50))
        return;
    g.lastPump = now;
    g.pumping = true;

    auto p = Session::instance().progressSnapshot();
    if (!g.onCancel && !p.phase.empty()) {
        g.detail = tr(installPhaseKey(p.phase), p.phase);
        g.done = p.done;
        g.total = p.total;
        g.bps = p.bps;
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
    if (runTick) runProgressTick(now);
}

void showProgress(const std::string& title, std::function<void()> onCancel) {
    g.uiThread = std::this_thread::get_id();
    g.visible = true;
    g.onCancel = std::move(onCancel);
    g.warning.clear();
    g.result = ProgressUi::Result::None;
    g.title = title;
    g.detail = "app/progress/starting"_i18n;
    g.done = 0;
    g.total = 0;
    g.bps = 0;
    pumpProgressUi(true);
}

void updateProgress(const std::string& line, uint64_t done, uint64_t total) {
    if (g.uiThread != std::thread::id() && std::this_thread::get_id() != g.uiThread) return;
    g.detail = line;
    g.done = done;
    g.total = total;
    pumpProgressUi();
}

void setProgressWarning(const std::string& text) {
    if (g.uiThread != std::thread::id() && std::this_thread::get_id() != g.uiThread) return;
    g.warning = text;
    pumpProgressUi(true);
}

bool progressVisible() { return g.visible; }

void setProgressTick(std::function<void()> fn) { g.tick = std::move(fn); }

void showProgressResult(bool ok, const std::string& title, const std::string& detail) {
    if (!g.visible) return;
    if (g.uiThread != std::thread::id() && std::this_thread::get_id() != g.uiThread) return;
    g.result = ok ? ProgressUi::Result::Ok : ProgressUi::Result::Failed;
    g.onCancel = nullptr;
    g.warning.clear();
    g.title = title;
    g.detail = detail;
    g.bps = 0;
    if (ok) {
        if (g.total == 0) g.total = 1;
        g.done = g.total;
    }

#ifdef __SWITCH__
    if (!g.padReady) {
        padInitializeDefault(&g.pad);
        g.padReady = true;
    }
#endif
    const auto shown = std::chrono::steady_clock::now();
    // Ignore buttons for a moment so a press meant for the install screen does not skip the result.
    const auto armed = shown + std::chrono::milliseconds(300);
    auto* platform = brls::Application::getPlatform();
    for (;;) {
        const auto now = std::chrono::steady_clock::now();
        if (ok && now - shown >= std::chrono::milliseconds(1500)) break;
        if (platform && !platform->mainLoopIteration()) {
            brls::Application::quit();
            break;
        }
#ifdef __SWITCH__
        padUpdate(&g.pad);
        const u64 down = padGetButtonsDown(&g.pad);
        if (now >= armed && (down & (HidNpadButton_A | HidNpadButton_B))) break;
#endif
        brls::Ticking::updateTickings();
        drawOverlay();
        // A failure can stay up for a long time: keep the side channel polling so the server still sees the device.
        runProgressTick(now);
        std::this_thread::sleep_for(std::chrono::milliseconds(16));
    }
    g.result = ProgressUi::Result::None;
}

void hideProgress() {
    g.result = ProgressUi::Result::None;
    g.visible = false;
    g.onCancel = nullptr;
    g.warning.clear();
    g.title.clear();
    g.detail.clear();
    g.done = 0;
    g.total = 0;
    g.bps = 0;
}

} // namespace nslib
