#include "ui/main_activity.hpp"

#include "app/services.hpp"
#include "app/session.hpp"
#include "install/app_record.hpp"
#include "installed/compare.hpp"
#include "ui/format.hpp"
#include "ui/widgets.hpp"

#include <algorithm>
#include <borealis.hpp>
#include <cstdio>
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

void addSection(brls::Box* box, const std::string& title, const std::vector<InstalledTitle>& titles,
    const std::unordered_map<std::string, std::string>& names, bool showVersion)
{
    if (titles.empty()) return;
    box->addView(makeHeader(title, std::to_string(titles.size())));
    for (const auto& t : titles) {
        std::string detail;
        if (showVersion) detail = formatVersion(t.version) + "   ";
        detail += tr(storageKey(t.storage), t.storage);
        const std::string name = titleName(names, t);
        std::string applicationId;
        if (t.type == "application") applicationId = upperHex(t.titleId);
        else if (t.type == "patch") applicationId = baseTitleIdForPatch(t.titleId);
        if (applicationId.empty()) {
            box->addView(makeCell(name, detail));
            continue;
        }
        // Games and their updates share one launch requirement, so either row can reset it.
        box->addView(makeCell(name, detail, [name, applicationId](brls::View*) {
            confirmResetRequiredVersion(name, applicationId);
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
        addSection(box, "app/type/applications"_i18n, games, names, false);
        addSection(box, "app/type/patches"_i18n, patches, names, true);
        addSection(box, "app/type/addons"_i18n, addons, names, true);
        addSection(box, "app/installed/other"_i18n, other, names, true);
    });
}

brls::View* InstalledTab::create() { return new InstalledTab(); }

} // namespace nslib
