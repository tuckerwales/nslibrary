#include "ui/main_activity.hpp"

#include "app/services.hpp"
#include "app/session.hpp"
#include "install/app_record.hpp"
#include "install/engine.hpp"
#include "installed/compare.hpp"
#include "installed/manage.hpp"
#include "ui/format.hpp"
#include "ui/progress.hpp"
#include "ui/widgets.hpp"

#include <algorithm>
#include <atomic>
#include <borealis.hpp>
#include <cstdio>
#include <memory>
#include <unordered_map>
#include <vector>

using namespace brls::literals;

namespace nslib {
namespace {

/** Title ids come from two sources; only their hex digits are meaningful, not their case. */
std::string upperHex(std::string id) {
    for (char& c : id) {
        if (c >= 'a' && c <= 'f') c = char(c - 'a' + 'A');
    }
    return id;
}

/** Every title id the catalog can name, base games and DLC alike. */
std::unordered_map<std::string, std::string> catalogNames() {
    std::unordered_map<std::string, std::string> names;
    for (const auto& app : Session::instance().catalogSnapshot()) {
        if (!app.name.empty()) names[upperHex(app.id)] = cleanTitleName(app.name);
        for (const auto& dlc : app.dlc) {
            if (!dlc.name.empty()) names[upperHex(dlc.titleId)] = cleanTitleName(dlc.name);
        }
    }
    return names;
}

/** "1.2 GB free of 119 GB", or just the free figure when the console did not report a total. */
std::string spaceText(const SpacePair& space) {
    if (!space.total) return brls::getStr("app/installed/free_only", formatSize(space.free));
    return brls::getStr("app/installed/free", formatSize(space.free), formatSize(space.total));
}

/** The library's name for an installed title. Updates borrow the name of the game they patch. */
std::string titleName(const std::unordered_map<std::string, std::string>& names, const InstalledTitle& t) {
    const std::string key = t.type == "patch" ? baseTitleIdForPatch(t.titleId) : upperHex(t.titleId);
    auto it = names.find(key);
    if (it != names.end()) return it->second;
    it = names.find(upperHex(t.titleId));
    if (it != names.end()) return it->second;
    return upperHex(t.titleId);
}

/** Offer DBI's "Reset required version" for the game `applicationId` (upper hex, 16 digits). */
void confirmResetRequiredVersion(const std::string& name, const std::string& applicationId) {
    uint64_t id = 0;
    try {
        id = std::stoull(applicationId, nullptr, 16);
    } catch (...) {
        return;
    }
    std::string body = name + "\n" + applicationId;
#ifdef __SWITCH__
    // Show what the console holds, so it is clear which check is in the way before resetting.
    const auto required = readRequiredVersions(id);
    if (required.system && *required.system) {
        body += "\n" + brls::getStr("app/installed/required_firmware", formatFirmware(*required.system),
                           firmwareVersion());
    }
    if (required.launch) {
        body += "\n" + "app/installed/required_version"_i18n + " " + formatVersion(*required.launch);
    }
#endif
    body += "\n\n" + "app/installed/reset_body"_i18n;

    auto* dialog = new brls::Dialog(body);
    dialog->addButton("app/installed/reset_version"_i18n, [id]() {
        brls::sync([id] {
#ifdef __SWITCH__
            const Result rc = resetRequiredVersions(id);
            if (R_FAILED(rc)) {
                char code[16];
                std::snprintf(code, sizeof(code), "0x%X", rc);
                showError(brls::getStr("app/installed/reset_failed", std::string(code)));
                return;
            }
#endif
            showError("app/installed/reset_done"_i18n);
        });
    });
    dialog->addButton("hints/cancel"_i18n, []() {});
    dialog->open();
}

std::string storageText(const std::string& storage) { return tr(storageKey(storage), storage); }

/** Uninstalling or moving has to wait for an install, and can't touch a game NSLibrary is running as. */
bool readyToChange(const InstalledTitle& row) {
    if (Session::instance().isInstalling()) {
        showError("app/installed/busy"_i18n);
        return false;
    }
#ifdef __SWITCH__
    if (runningInPlaceOf(row)) {
        showError("app/installed/in_use"_i18n);
        return false;
    }
#else
    (void)row;
#endif
    return true;
}

/** Rescan, tell the library server (so the web UI sees the new free space), and redraw. */
void afterChange() {
    Session::instance().refreshInstalled();
    refreshVisibleTabs();
}

void runUninstall(const InstalledTitle& row, const std::string& name) {
    if (!readyToChange(row)) return;
    showProgress(brls::getStr("app/installed/uninstalling", name), [] {});
    std::string error;
#ifdef __SWITCH__
    try {
        uninstallTitle(row);
    } catch (const std::exception& e) {
        error = e.what();
    }
#endif
    if (!error.empty()) {
        brls::Logger::error("uninstall {}: {}", row.titleId, error);
        showProgressResult(false, brls::getStr("app/installed/uninstall_failed", name), error);
    }
    hideProgress();
    afterChange();
    if (error.empty()) brls::Application::notify(brls::getStr("app/installed/uninstalled", name));
}

void confirmUninstall(const InstalledTitle& row, const std::string& name) {
    TitleFootprint footprint;
#ifdef __SWITCH__
    footprint = measureTitle(row);
#endif
    const char* key = row.type == "application" ? "app/installed/confirm_uninstall_game"
        : row.type == "patch"                     ? "app/installed/confirm_uninstall_patch"
                                                  : "app/installed/confirm_uninstall_addon";
    auto* dialog = new brls::Dialog(name + "\n\n" + brls::getStr(key, formatSize(footprint.bytes)));
    dialog->addButton("app/installed/uninstall"_i18n, [row, name]() {
        brls::sync([row, name] { runUninstall(row, name); });
    });
    dialog->addButton("hints/cancel"_i18n, []() {});
    dialog->open();
}

void runMove(const InstalledTitle& row, const std::string& name, const std::string& to) {
    if (!readyToChange(row)) return;
    auto cancel = std::make_shared<std::atomic<bool>>(false);
    showProgress(brls::getStr("app/installed/moving", name), [cancel] { *cancel = true; });
    std::string error;
    bool cancelled = false;
#ifdef __SWITCH__
    try {
        moveTitle(row, to,
            [](uint64_t done, uint64_t total) {
                std::string line = "app/installed/copying"_i18n;
                const std::string pct = formatPercent(done, total);
                if (!pct.empty()) line += "   " + pct;
                if (total) line += "   " + formatOfTotal(done, total);
                updateProgress(line, done, total);
            },
            cancel.get());
    } catch (const InstallError& e) {
        cancelled = e.result == "cancelled";
        error = e.what();
    } catch (const std::exception& e) {
        error = e.what();
    }
#endif
    if (error.empty()) {
        showProgressResult(true, brls::getStr("app/installed/moved", name, storageText(to)));
    } else if (!cancelled) {
        brls::Logger::error("move {}: {}", row.titleId, error);
        showProgressResult(false, brls::getStr("app/installed/move_failed", name), error);
    }
    hideProgress();
    afterChange();
}

void confirmMove(const InstalledTitle& row, const std::string& name, const std::string& to) {
    TitleFootprint footprint;
    std::optional<SpacePair> space;
#ifdef __SWITCH__
    footprint = measureTitle(row, to);
    space = storageSpace(to == "nand");
#endif
    if (space && space->free < footprint.toCopy) {
        showError(brls::getStr("app/installed/move_no_space", storageText(to), formatSize(footprint.toCopy),
            formatSize(space->free)));
        return;
    }
    const std::string body = name + "\n\n" +
        brls::getStr("app/installed/confirm_move", formatSize(footprint.toCopy), storageText(to),
            storageText(row.storage));
    auto* dialog = new brls::Dialog(body);
    dialog->addButton(brls::getStr("app/installed/move_to", storageText(to)), [row, name, to]() {
        brls::sync([row, name, to] { runMove(row, name, to); });
    });
    dialog->addButton("hints/cancel"_i18n, []() {});
    dialog->open();
}

/** What can be done with one installed title: uninstall, move, and for games and updates, reset. */
void openTitleActions(const InstalledTitle& row, const std::string& name, bool hasSd) {
    std::string body = name + "\n" + upperHex(row.titleId);
    if (row.type != "application" && row.version) body += "   " + formatVersion(row.version);
    TitleFootprint footprint;
#ifdef __SWITCH__
    footprint = measureTitle(row);
#endif
    body += "\n" + storageText(row.storage);
    if (footprint.bytes) body += "   " + brls::getStr("app/installed/uses", formatSize(footprint.bytes));
    if (row.type == "application" && footprint.titles > 1) body += "\n" + "app/installed/includes_extras"_i18n;

    auto* dialog = new brls::Dialog(body);
    dialog->addButton("app/installed/uninstall"_i18n, [row, name]() {
        brls::sync([row, name] { confirmUninstall(row, name); });
    });
    const std::string to = moveTargetFor(row.storage, hasSd);
    if (!to.empty()) {
        dialog->addButton(brls::getStr("app/installed/move_to", storageText(to)), [row, name, to]() {
            brls::sync([row, name, to] { confirmMove(row, name, to); });
        });
    }
    // Games and their updates share one launch requirement, so either row can reset it.
    if (row.type == "application" || row.type == "patch") {
        const std::string applicationId = applicationIdFor(row);
        dialog->addButton("app/installed/reset_version"_i18n, [name, applicationId]() {
            brls::sync([name, applicationId] { confirmResetRequiredVersion(name, applicationId); });
        });
    }
    dialog->open();
}

void addSection(brls::Box* box, const std::string& title, const std::vector<InstalledTitle>& titles,
    const std::unordered_map<std::string, std::string>& names, bool showVersion, bool hasSd, bool actions = true)
{
    if (titles.empty()) return;
    box->addView(makeHeader(title, std::to_string(titles.size())));
    for (const auto& t : titles) {
        std::string detail;
        if (showVersion) detail = formatVersion(t.version) + "   ";
        detail += storageText(t.storage);
        const std::string name = titleName(names, t);
        if (!actions) {
            box->addView(makeCell(name, detail));
            continue;
        }
        box->addView(makeCell(name, detail, [t, name, hasSd](brls::View*) {
            openTitleActions(t, name, hasSd);
            return true;
        }));
    }
}

} // namespace

InstalledTab::InstalledTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    rebuild();
}

void InstalledTab::rebuild() {
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    const auto state = Session::instance().installedSnapshot();

    setHeader(dynamic_cast<brls::Header*>(this->getView("header")), "app/tabs/installed"_i18n, state.titles.size());
    setStatusLine(dynamic_cast<brls::Label*>(this->getView("status")), "");
    if (!list) return;

    const auto names = catalogNames();
    std::vector<InstalledTitle> games, patches, addons, other;
    for (const auto& t : state.titles) {
        if (t.type == "application") games.push_back(t);
        else if (t.type == "patch") patches.push_back(t);
        else if (t.type == "addon" || t.type == "aoc") addons.push_back(t);
        else other.push_back(t);
    }
    // Sorting by name keeps a game next to its update instead of in scan order.
    const auto byName = [&](const InstalledTitle& a, const InstalledTitle& b) {
        return titleName(names, a) < titleName(names, b);
    };
    std::sort(games.begin(), games.end(), byName);
    std::sort(patches.begin(), patches.end(), byName);
    std::sort(addons.begin(), addons.end(), byName);

    replaceChildren(list, [&](brls::Box* box) {
        box->addView(makeHeader("app/installed/console"_i18n));
        if (!state.fw.empty()) box->addView(makeInfoCell("app/installed/firmware"_i18n, state.fw));
        if (!state.ams.empty()) box->addView(makeInfoCell("app/installed/ams"_i18n, state.ams));
        if (state.sd) {
            box->addView(makeInfoCell("app/storage/sd"_i18n, spaceText(*state.sd)));
        }
        if (state.nand.total || state.nand.free) {
            box->addView(makeInfoCell("app/storage/nand"_i18n, spaceText(state.nand)));
        }

        if (state.titles.empty()) {
            box->addView(makeEmptyState("app/installed/empty"_i18n));
            return;
        }
        const bool hasSd = state.sd.has_value();
        addSection(box, "app/type/applications"_i18n, games, names, false, hasSd);
        addSection(box, "app/type/patches"_i18n, patches, names, true, hasSd);
        addSection(box, "app/type/addons"_i18n, addons, names, true, hasSd);
        // Unknown kinds are listed, but not offered for removal: nothing here knows what they are.
        addSection(box, "app/installed/other"_i18n, other, names, true, hasSd, false);
    });
}

brls::View* InstalledTab::create() { return new InstalledTab(); }

} // namespace nslib
