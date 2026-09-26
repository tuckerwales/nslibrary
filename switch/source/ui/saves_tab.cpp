#include "ui/saves.hpp"

#include "app/session.hpp"
#include "saves/console.hpp"
#include "ui/format.hpp"
#include "ui/main_activity.hpp"
#include "ui/progress.hpp"
#include "ui/widgets.hpp"

#include <borealis.hpp>
#include <ctime>

#ifdef __SWITCH__
#include <switch.h>
#endif
#include <memory>
#include <stdexcept>

using namespace brls::literals;

namespace nslib {
namespace {

/** What the tab shows. Loading touches the save filesystem and the network, so it is kept between rebuilds. */
struct SavesState {
    bool loaded = false;
    std::vector<ConsoleSave> saves;
    /** Newest backup of each save on the server, from every console. */
    std::vector<SaveBackup> latest;
    std::string error;
};

SavesState& state() {
    static SavesState s;
    return s;
}

int64_t nowSeconds() { return int64_t(std::time(nullptr)); }

std::string agoText(int64_t at) {
    const Ago ago = agoFrom(at, nowSeconds());
    switch (ago.unit) {
        case Ago::Unit::Now:
            return "app/saves/ago_now"_i18n;
        case Ago::Unit::Minutes:
            return brls::getStr("app/saves/ago_minutes", ago.count);
        case Ago::Unit::Hours:
            return brls::getStr("app/saves/ago_hours", ago.count);
        case Ago::Unit::Days:
            return ago.count == 1 ? "app/saves/ago_day"_i18n : brls::getStr("app/saves/ago_days", ago.count);
        case Ago::Unit::Older:
            break;
    }
    return formatBackupDate(at);
}

std::string gameName(const ConsoleSave& save) {
    if (!save.gameName.empty()) return cleanTitleName(save.gameName);
    // A save whose game is gone: the library may still know its name.
    for (const auto& app : Session::instance().catalogSnapshot()) {
        if (app.id == save.appId && !app.name.empty()) return cleanTitleName(app.name);
    }
    return save.appId;
}

std::string ownerName(const ConsoleSave& save) {
    if (save.type == "device") return "app/saves/device_save"_i18n;
    return save.userName.empty() ? save.userId : save.userName;
}

/** The newest backup this console made of `save`, if the server has one. */
const SaveBackup* latestMine(const ConsoleSave& save) {
    for (const auto& backup : state().latest) {
        if (backup.mine && isSameSave(save, backup)) return &backup;
    }
    return nullptr;
}

/** Newest backups on the server. Cheap: done after every backup and restore. */
void reloadServer() {
    auto& s = state();
    try {
        s.latest = Session::instance().listSaveBackups("", true);
        s.error.clear();
    } catch (const std::exception& e) {
        s.latest.clear();
        s.error = e.what();
    }
}

/** Both lists, behind the progress overlay: looking up every game's name takes a moment. */
void reload() {
    auto& s = state();
    s.loaded = true;
    showProgress("app/saves/loading"_i18n, [] {});
    try {
        s.saves = listConsoleSaves([](size_t done, size_t total) { updateProgress("", done, total); });
        reloadServer();
    } catch (const std::exception& e) {
        s.saves.clear();
        s.error = e.what();
    }
    hideProgress();
}

/**
 * Runs a backup or restore behind the progress overlay, then reports how it went. B cancels while
 * reading the save or downloading, and a restore up until it starts writing. An upload is only
 * stopped by the transport: over the network straight away, over USB once it has been sent, so
 * the link stays in step. Writing cannot be cancelled once it starts. If it fails, a save that fits
 * its journal is left as it was; a bigger one is committed in parts and can be left incomplete,
 * which the error says, and the backup made before the restore puts it back.
 */
void runWithProgress(const std::string& title, const std::string& failTitle,
    const std::function<std::string(const SaveStepFn&)>& work)
{
    auto cancelled = std::make_shared<bool>(false);
    showProgress(title, [cancelled] {
        *cancelled = true;
        Session::instance().abortSaveTransfer();
    });
    const SaveStepFn step = [cancelled](const std::string& phase, uint64_t done, uint64_t total) {
        // Writing reports 0 once before it touches the save: the last point a cancel is safe.
        const bool cancellable = phase == "app/saves/phase_reading" || phase == "app/saves/phase_downloading" ||
            (phase == "app/saves/phase_writing" && done == 0);
        if (cancellable && *cancelled) throw std::runtime_error("cancelled");
        std::string line = brls::getStr(phase);
        const std::string pct = formatPercent(done, total);
        if (!pct.empty()) line += "   " + pct;
        if (total) line += "   " + formatOfTotal(done, total);
        updateProgress(line, done, total);
    };
    try {
        const std::string detail = work(step);
        showProgressResult(true, detail.empty() ? title : detail);
    } catch (const std::exception& e) {
        if (!*cancelled || std::string(e.what()) != "cancelled") showProgressResult(false, failTitle, e.what());
    }
    hideProgress();
}

std::string backupSummary(const SaveBackupResult& result) {
    return result.unchanged ? "app/saves/unchanged"_i18n : "app/saves/backed_up"_i18n;
}

} // namespace

std::string formatBackupDate(int64_t epochSeconds) {
    char buf[32] = {};
#ifdef __SWITCH__
    TimeCalendarTime ct{};
    TimeCalendarAdditionalInfo info{};
    if (R_SUCCEEDED(timeToCalendarTimeWithMyRule(u64(epochSeconds), &ct, &info))) {
        std::snprintf(buf, sizeof(buf), "%04u-%02u-%02u %02u:%02u", ct.year, ct.month, ct.day, ct.hour, ct.minute);
        return buf;
    }
#endif
    const std::time_t t = std::time_t(epochSeconds);
    std::tm tm{};
    gmtime_r(&t, &tm);
    std::strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M", &tm);
    return buf;
}

SavesTab::SavesTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    this->registerAction("app/saves/refresh"_i18n, brls::BUTTON_Y, [](brls::View*) {
        brls::sync([] {
            reload();
            refreshVisibleTabs();
        });
        return true;
    });
    rebuild();
    // Loading draws the progress overlay, which must not happen while the tab is being built.
    if (!state().loaded) {
        brls::sync([] {
            reload();
            refreshVisibleTabs();
        });
    }
}

void SavesTab::rebuild() {
    auto& session = Session::instance();
    const auto& s = state();
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    setHeader(dynamic_cast<brls::Header*>(this->getView("header")), "app/tabs/saves"_i18n, s.saves.size());
    const bool supported = session.supportsSaves();
    setStatusLine(dynamic_cast<brls::Label*>(this->getView("status")),
        !supported ? "app/saves/unsupported"_i18n : s.error.empty() ? "app/saves/intro"_i18n : s.error);
    if (!list) return;

    replaceChildren(list, [&](brls::Box* box) {
        if (!supported || !s.loaded) return;
        if (s.saves.empty()) {
            box->addView(makeEmptyState("app/saves/empty"_i18n));
            return;
        }
        box->addView(makeCell("app/saves/backup_all"_i18n, std::to_string(s.saves.size()), [](brls::View*) {
            brls::sync([] { backUpEverySave(); });
            return true;
        }));
        box->addView(makeHeader("app/saves/on_console"_i18n, std::to_string(s.saves.size())));
        for (const auto& save : s.saves) {
            const SaveBackup* last = latestMine(save);
            const std::string detail = last ? agoText(last->at) : "app/saves/never"_i18n;
            box->addView(makeCell(gameName(save) + "   " + ownerName(save), detail, [save](brls::View*) {
                brls::Application::pushActivity(new SaveDetailActivity(save));
                return true;
            }));
        }
    });
}

brls::View* SavesTab::create() { return new SavesTab(); }

void backUpEverySave() {
    auto& session = Session::instance();
    reload();
    const auto saves = state().saves;
    if (saves.empty()) {
        refreshVisibleTabs();
        return;
    }
    size_t stored = 0, unchanged = 0;
    std::vector<std::string> failures;
    auto cancelled = std::make_shared<bool>(false);
    showProgress("app/saves/backing_up_all"_i18n, [cancelled] {
        *cancelled = true;
        Session::instance().abortSaveTransfer();
    });
    for (size_t i = 0; i < saves.size() && !*cancelled; i++) {
        const auto& save = saves[i];
        const std::string name = gameName(save) + "   " + ownerName(save);
        updateProgress(name, i, saves.size());
        // Skip the upload only when a manual backup already has these bytes. One made before a
        // restore goes up anyway, so the server can count it as manual from now on.
        const SaveBackup* last = latestMine(save);
        const std::string unchangedSince = last && last->origin == "manual" ? last->sha256 : "";
        try {
            const auto result = session.backupSave(save, "manual", unchangedSince,
                [&](const std::string& phase, uint64_t, uint64_t) {
                    const bool cancellable = phase == "app/saves/phase_reading";
                    if (cancellable && *cancelled) throw std::runtime_error("cancelled");
                    updateProgress(name + "   " + brls::getStr(phase), i, saves.size());
                });
            if (result.unchanged) unchanged++;
            else stored++;
        } catch (const std::exception& e) {
            if (*cancelled && std::string(e.what()) == "cancelled") break;
            failures.push_back(name + ": " + e.what());
        }
    }
    reloadServer();
    std::string detail = brls::getStr("app/saves/all_summary", std::to_string(stored), std::to_string(unchanged));
    if (!failures.empty()) {
        detail += "\n\n";
        for (size_t i = 0; i < failures.size() && i < 4; i++) detail += failures[i] + "\n";
        if (failures.size() > 4) detail += brls::getStr("app/saves/more_failures", std::to_string(failures.size() - 4));
    }
    if (!*cancelled || !failures.empty() || stored || unchanged) {
        showProgressResult(failures.empty(), failures.empty() ? "app/saves/all_done"_i18n : "app/saves/all_failed"_i18n,
            detail);
    }
    hideProgress();
    refreshVisibleTabs();
}

SaveDetailActivity::SaveDetailActivity(ConsoleSave save) : save_(std::move(save)) {}

brls::View* SaveDetailActivity::createContentView() {
    auto* scroll = new brls::ScrollingFrame();
    auto* box = new brls::Box(brls::Axis::COLUMN);
    box->setPadding(24, 40, 30, 40);
    scroll->setContentView(box);
    auto* frame = new brls::AppletFrame(scroll);
    frame->setTitle(gameName(save_));

    auto* who = new brls::Label();
    who->setText(ownerName(save_) + "   " + save_.appId);
    who->setFontSize(18);
    who->setTextColor(brls::Application::getTheme()["brls/text_disabled"]);
    who->setMarginBottom(12);
    box->addView(who);

    list_ = new brls::Box(brls::Axis::COLUMN);
    box->addView(list_);
    load();
    fill();
    return frame;
}

void SaveDetailActivity::load() {
    error_.clear();
    try {
        // Any user's or console's backup of the same kind of save can go in; the other kind cannot.
        backups_.clear();
        for (auto& backup : Session::instance().listSaveBackups(save_.appId, false)) {
            if (backup.type == save_.type) backups_.push_back(std::move(backup));
        }
    } catch (const std::exception& e) {
        backups_.clear();
        error_ = e.what();
    }
}

void SaveDetailActivity::fill() {
    replaceChildren(list_, [this](brls::Box* box) {
        box->addView(makeCell("app/saves/backup_now"_i18n, "", [this](brls::View*) {
            brls::sync([this] { backUp(); });
            return true;
        }));
        box->addView(makeHeader("app/saves/on_server"_i18n, std::to_string(backups_.size())));
        if (!error_.empty()) {
            box->addView(makeEmptyState(error_));
            return;
        }
        if (backups_.empty()) {
            box->addView(makeEmptyState("app/saves/none_on_server"_i18n));
            return;
        }
        for (const auto& backup : backups_) {
            std::string title = formatBackupDate(backup.at);
            if (isSameSave(save_, backup) && backup.mine) title += "   " + "app/saves/this_save"_i18n;
            if (backup.origin == "pre-restore") title += "   " + "app/saves/before_restore"_i18n;
            if (backup.pinned) title += "   " + "app/saves/pinned"_i18n;
            std::string detail = backup.device;
            if (backup.type == "device") detail += " · " + "app/saves/device_save"_i18n;
            else if (!backup.userName.empty()) detail += " · " + backup.userName;
            detail += " · " + formatSize(backup.dataSize);
            if (!backup.note.empty()) detail = backup.note + "   " + detail;
            box->addView(makeCell(title, detail, [this, backup](brls::View*) {
                confirmRestore(backup);
                return true;
            }));
        }
    });
}

void SaveDetailActivity::backUp() {
    const ConsoleSave save = save_;
    runWithProgress("app/saves/backing_up"_i18n, "app/saves/backup_failed"_i18n, [save](const SaveStepFn& step) {
        return backupSummary(Session::instance().backupSave(save, "manual", {}, step));
    });
    reloadServer();
    load();
    fill();
    refreshVisibleTabs();
}

void SaveDetailActivity::confirmRestore(const SaveBackup& backup) {
    const std::string body = brls::getStr("app/saves/restore_body", formatBackupDate(backup.at), ownerName(save_));
    auto* dialog = new brls::Dialog(body);
    dialog->addButton("app/saves/restore"_i18n, [this, backup] {
        // Start after the dialog has closed so the progress overlay does not draw over it.
        brls::sync([this, backup] { restore(backup); });
    });
    dialog->addButton("hints/cancel"_i18n, [] {});
    dialog->open();
}

void SaveDetailActivity::restore(const SaveBackup& backup) {
    const ConsoleSave save = save_;
    runWithProgress("app/saves/restoring"_i18n, "app/saves/restore_failed"_i18n, [save, backup](const SaveStepFn& step) {
        Session::instance().restoreSave(save, backup, step);
        return "app/saves/restored"_i18n;
    });
    reloadServer();
    load();
    fill();
    refreshVisibleTabs();
}

} // namespace nslib
