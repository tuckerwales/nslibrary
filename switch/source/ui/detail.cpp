#include "ui/detail.hpp"

#include "app/session.hpp"
#include "ui/icon_cache.hpp"
#include "ui/main_activity.hpp"

#include <atomic>
#include <cstdio>
#include <memory>

using namespace brls::literals;

namespace nslib {
namespace {

std::string formatSize(uint64_t n) {
    if (n >= 1024ull * 1024ull * 1024ull) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.1f GB", double(n) / (1024.0 * 1024.0 * 1024.0));
        return buf;
    }
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.0f MB", double(n) / (1024.0 * 1024.0));
    return buf;
}

std::string installedLine(const CatalogApp& app) {
    uint32_t have = 0;
    std::string storage;
    for (const auto& t : Session::instance().installedSnapshot().titles) {
        if (t.titleId == app.id && t.version >= have) {
            have = t.version;
            storage = t.storage;
        }
    }
    if (storage.empty()) return "app/detail/not_installed"_i18n;
    return "app/detail/installed"_i18n + std::string(" v") + std::to_string(have) + " (" + storage + ")";
}

brls::DetailCell* makeRow(const std::string& title, const std::string& detail, std::function<bool(brls::View*)> onClick) {
    auto* cell = new brls::DetailCell();
    cell->setText(title);
    cell->setDetailText(detail);
    if (onClick) cell->registerClickAction(std::move(onClick));
    return cell;
}

} // namespace

void confirmInstall(int64_t contentMetaId, const std::string& name, uint64_t size) {
    if (!contentMetaId) {
        showError("app/library/nothing"_i18n);
        return;
    }
    std::string body = "app/detail/install_body"_i18n + std::string("\n") + name;
    if (size) body += "\n" + formatSize(size);
    auto* dialog = new brls::Dialog(body);
    auto enqueue = [contentMetaId](const std::string& target) {
        return [contentMetaId, target]() { Session::instance().queueInstall(contentMetaId, target); };
    };
    dialog->addButton("app/detail/sd"_i18n, enqueue("sd"));
    dialog->addButton("app/detail/nand"_i18n, enqueue("nand"));
    dialog->addButton("app/detail/auto"_i18n, enqueue("auto"));
    dialog->open();
}

TitleDetailActivity::TitleDetailActivity(CatalogApp app) : app_(std::move(app)) {}

TitleDetailActivity::~TitleDetailActivity() { alive_->store(false); }

brls::View* TitleDetailActivity::createContentView() {
    auto* scroll = new brls::ScrollingFrame();
    auto* box = new brls::Box(brls::Axis::COLUMN);
    box->setPadding(20, 40, 20, 40);
    scroll->setContentView(box);
    auto* frame = new brls::AppletFrame(scroll);
    frame->setTitle(app_.name.empty() ? app_.id : app_.name);

    auto* header = new brls::Box(brls::Axis::ROW);
    header->setAlignItems(brls::AlignItems::CENTER);
    auto* icon = new brls::Image();
    icon->setWidth(128);
    icon->setHeight(128);
    icon->setScalingType(brls::ImageScalingType::FILL);
    header->addView(icon);
    loadAppIcon(icon, alive_, app_.id, app_.iconRev);

    auto* info = new brls::Box(brls::Axis::COLUMN);
    info->setPaddingLeft(20);
    auto* name = new brls::Label();
    name->setText(app_.name.empty() ? app_.id : app_.name);
    info->addView(name);
    auto* pub = new brls::Label();
    pub->setText(app_.publisher.empty() ? app_.id : app_.publisher);
    info->addView(pub);
    auto* inst = new brls::Label();
    inst->setText(installedLine(app_));
    info->addView(inst);
    if (app_.requiredSysVersion) {
        auto* fw = new brls::Label();
        const uint32_t v = *app_.requiredSysVersion;
        char buf[64];
        const std::string fwLabel = "app/detail/firmware"_i18n;
        std::snprintf(buf, sizeof(buf), "%s %u.%u.%u", fwLabel.c_str(), (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
        fw->setText(buf);
        info->addView(fw);
    }
    header->addView(info);
    box->addView(header);

    if (app_.base) {
        const auto base = *app_.base;
        box->addView(makeRow("app/detail/base"_i18n, "v" + std::to_string(base.version) + "  " + formatSize(base.size),
            [app = app_, base](brls::View*) {
                confirmInstall(base.contentMetaId, app.name, base.size);
                return true;
            }));
    }
    for (const auto& upd : app_.updates) {
        box->addView(makeRow("app/detail/update"_i18n, "v" + std::to_string(upd.version) + "  " + formatSize(upd.size),
            [app = app_, upd](brls::View*) {
                confirmInstall(upd.contentMetaId, app.name + " v" + std::to_string(upd.version), upd.size);
                return true;
            }));
    }
    for (const auto& dlc : app_.dlc) {
        box->addView(makeRow(dlc.name.empty() ? "app/detail/dlc"_i18n : dlc.name,
            dlc.titleId + "  v" + std::to_string(dlc.version), [dlc](brls::View*) {
                confirmInstall(dlc.contentMetaId, dlc.name, dlc.size);
                return true;
            }));
    }
    if (!app_.base && app_.updates.empty() && app_.dlc.empty()) {
        auto* empty = new brls::Label();
        empty->setText("app/library/nothing"_i18n);
        box->addView(empty);
    }
    return frame;
}

} // namespace nslib
