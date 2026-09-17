#include "ui/detail.hpp"

#include "app/services.hpp"
#include "app/session.hpp"
#include "install/preflight.hpp"
#include "installed/compare.hpp"
#include "ui/format.hpp"
#include "ui/icon_cache.hpp"
#include "ui/main_activity.hpp"
#include "ui/widgets.hpp"

#include <atomic>
#include <memory>
#include <unordered_set>
#include <vector>

using namespace brls::literals;

namespace nslib {
namespace {

constexpr float kArt = 160;

/** Title ids come from two sources; only their hex digits are meaningful, not their case. */
std::string upperHex(std::string id) {
    for (char& c : id) {
        if (c >= 'a' && c <= 'f') c = char(c - 'a' + 'A');
    }
    return id;
}

/** What this console already has of the title, in one line. */
std::string installedLine(const InstalledSummary& s) {
    if (!s.baseInstalled && s.patchVersion == 0) return "app/detail/not_installed"_i18n;
    std::string line = "app/detail/installed"_i18n;
    if (s.baseInstalled && !s.baseStorage.empty()) line += " (" + tr(storageKey(s.baseStorage), s.baseStorage) + ")";
    if (s.patchVersion) line += "   " + "app/type/patch"_i18n + " " + formatVersion(s.patchVersion);
    return line;
}

/** Title ids of everything on this console, so each row can say whether it is already there. */
std::unordered_set<std::string> installedIds() {
    std::unordered_set<std::string> ids;
    for (const auto& t : Session::instance().installedSnapshot().titles) ids.insert(upperHex(t.titleId));
    return ids;
}

std::string withInstalledMark(const std::string& text, bool installed) {
    if (!installed) return text;
    return text + "   " + "app/detail/on_console"_i18n;
}

brls::Label* makeInfoLabel(const std::string& text, float size, const char* color) {
    auto* label = new brls::Label();
    label->setText(text);
    label->setFontSize(size);
    label->setSingleLine(true);
    // A label is laid out at its font size, so stacked lines need their own breathing room.
    label->setMarginBottom(8);
    if (color) label->setTextColor(brls::Application::getTheme()[color]);
    return label;
}

} // namespace

void confirmInstall(int64_t contentMetaId, const std::string& name, uint64_t size,
    std::optional<uint32_t> requiredSystemVersion)
{
    if (!contentMetaId) {
        showError("app/library/nothing"_i18n);
        return;
    }
    std::string body = "app/detail/install_body"_i18n + std::string("\n") + cleanTitleName(name);
    if (size) body += "\n" + formatSize(size);
    if (requiredSystemVersion && firmwareTooNew(*requiredSystemVersion, currentFirmwarePacked())) {
        const bool clearing = Session::instance().settings.clearFirmwareRequirement;
        body += "\n\n" + brls::getStr(clearing ? "app/detail/clear_firmware" : "app/detail/warn_firmware_version",
                               formatFirmware(*requiredSystemVersion));
    }
    if (batteryShouldWarn(batteryPercent(), batteryCharging())) {
        body += "\n\n" + "app/detail/warn_battery"_i18n;
    }
    auto* dialog = new brls::Dialog(body);
    auto enqueue = [contentMetaId](const std::string& target) {
        return [contentMetaId, target]() {
            // Start after the dialog has closed so the progress overlay does not draw over it.
            brls::sync([contentMetaId, target] { Session::instance().queueInstall(contentMetaId, target); });
        };
    };
    // The storage picked in Settings goes first, so the highlighted button is the usual answer.
    std::vector<std::string> targets = {"sd", "nand", "auto"};
    const std::string preferred = Session::instance().settings.defaultTarget;
    for (size_t i = 0; i < targets.size(); i++) {
        if (targets[i] != preferred) continue;
        std::swap(targets[0], targets[i]);
        break;
    }
    for (const auto& target : targets) dialog->addButton(tr(storageKey(target), target), enqueue(target));
    dialog->open();
}

TitleDetailActivity::TitleDetailActivity(CatalogApp app) : app_(std::move(app)) {}

TitleDetailActivity::~TitleDetailActivity() { alive_->store(false); }

brls::View* TitleDetailActivity::createContentView() {
    const std::string name = cleanTitleName(app_.name.empty() ? app_.id : app_.name);
    auto* scroll = new brls::ScrollingFrame();
    auto* box = new brls::Box(brls::Axis::COLUMN);
    box->setPadding(24, 40, 30, 40);
    scroll->setContentView(box);
    auto* frame = new brls::AppletFrame(scroll);
    frame->setTitle(name);

    auto* header = new brls::Box(brls::Axis::ROW);
    header->setAlignItems(brls::AlignItems::CENTER);
    header->setMarginBottom(8);

    auto* art = new brls::Box();
    art->setWidth(kArt);
    art->setHeight(kArt);
    art->setCornerRadius(8);
    art->setBackgroundColor(brls::Application::getTheme()["brls/sidebar/background"]);
    auto* icon = new brls::Image();
    icon->setWidth(kArt);
    icon->setHeight(kArt);
    icon->setCornerRadius(8);
    icon->setScalingType(brls::ImageScalingType::FILL);
    art->addView(icon);
    header->addView(art);
    loadAppIcon(icon, alive_, app_.id, app_.iconRev);

    // The applet frame already shows the name, so this column carries only what it does not.
    auto* info = new brls::Box(brls::Axis::COLUMN);
    info->setPaddingLeft(24);
    info->setGrow(1.0f);
    if (!app_.publisher.empty()) info->addView(makeInfoLabel(cleanTitleName(app_.publisher), 20, nullptr));
    const auto summary = summarizeInstalled(Session::instance().installedSnapshot().titles, app_.id);
    info->addView(makeInfoLabel(installedLine(summary), 18,
        summary.baseInstalled ? "brls/accent" : "brls/text_disabled"));
    if (app_.requiredSysVersion) {
        info->addView(makeInfoLabel(
            "app/detail/firmware"_i18n + std::string(" ") + formatFirmware(*app_.requiredSysVersion), 18,
            "brls/text_disabled"));
    }
    info->addView(makeInfoLabel(upperHex(app_.id), 16, "brls/text_disabled"));
    header->addView(info);
    box->addView(header);

    const auto installed = installedIds();

    if (app_.base) {
        const auto base = *app_.base;
        box->addView(makeHeader("app/detail/base"_i18n));
        std::string detail = formatSize(base.size);
        if (base.version) detail = formatVersion(base.version) + "   " + detail;
        box->addView(makeCell(withInstalledMark(name, summary.baseInstalled), detail,
            [app = app_, base, name](brls::View*) {
                confirmInstall(base.contentMetaId, name, base.size, app.requiredSysVersion);
                return true;
            }));
    }

    if (!app_.updates.empty()) {
        box->addView(makeHeader("app/type/patches"_i18n, std::to_string(app_.updates.size())));
        for (const auto& upd : app_.updates) {
            const std::string label = "app/type/patch"_i18n + std::string(" ") + formatVersion(upd.version);
            box->addView(makeCell(withInstalledMark(label, summary.patchVersion >= upd.version && upd.version),
                formatSize(upd.size), [app = app_, upd, name](brls::View*) {
                    confirmInstall(upd.contentMetaId, name + " " + formatVersion(upd.version), upd.size,
                        app.requiredSysVersion);
                    return true;
                }));
        }
    }

    if (!app_.dlc.empty()) {
        box->addView(makeHeader("app/type/addons"_i18n, std::to_string(app_.dlc.size())));
        for (const auto& dlc : app_.dlc) {
            const std::string label = dlc.name.empty() ? upperHex(dlc.titleId) : cleanTitleName(dlc.name);
            std::string detail = formatSize(dlc.size);
            if (dlc.version) detail = formatVersion(dlc.version) + "   " + detail;
            box->addView(makeCell(withInstalledMark(label, installed.count(upperHex(dlc.titleId)) > 0), detail,
                [dlc, label](brls::View*) {
                    confirmInstall(dlc.contentMetaId, label, dlc.size);
                    return true;
                }));
        }
    }

    if (!app_.base && app_.updates.empty() && app_.dlc.empty()) {
        box->addView(makeEmptyState("app/library/nothing"_i18n));
    }
    return frame;
}

} // namespace nslib
