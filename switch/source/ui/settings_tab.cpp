#include "ui/main_activity.hpp"

#include "app/file_log.hpp"
#include "app/session.hpp"
#include "ui/connect.hpp"
#include "ui/pair.hpp"
#include "ui/widgets.hpp"

#include <borealis.hpp>
#include <string>

using namespace brls::literals;

namespace nslib {

namespace {

// Self-update lives behind the Switch build: AvailableUpdate and the update client are libnx-only.
#ifdef __SWITCH__

void offerUpdate(const AvailableUpdate& found) {
    const char* key = found.fromServer ? "app/settings/update_available_server" : "app/settings/update_available";
    auto* dialog = new brls::Dialog(brls::getStr(key) + "\n" + found.manifest.version);
    dialog->addButton("hints/ok"_i18n, [found] {
        brls::sync([found] {
            try {
                Session::instance().installUpdate(found);
                brls::Application::notify("app/settings/update_done"_i18n);
            } catch (const std::exception& e) {
                if (std::string(e.what()) != "cancelled") showError(e.what());
            }
        });
    });
    dialog->addButton("hints/cancel"_i18n, [] {});
    dialog->open();
}

/**
 * Runs on the UI thread: curl on Switch must stay on main, and the progress overlay keeps frames coming.
 * The library server is asked first (it works without internet access), then GitHub.
 */
void checkForUpdates() {
    auto& session = Session::instance();
    std::string serverError;
    bool serverCurrent = false;
    if (session.settings.useUsb || session.hasToken()) {
        try {
            const auto found = session.checkServerUpdate();
            if (found.newer) {
                offerUpdate(found);
                return;
            }
            serverCurrent = true;
        } catch (const std::exception& e) {
            if (std::string(e.what()) == "cancelled") return;
            serverError = e.what();
        }
    }

    try {
        const auto found = session.checkGithubUpdate();
        if (found.newer) {
            offerUpdate(found);
            return;
        }
        showError("app/settings/update_none"_i18n);
    } catch (const std::exception& e) {
        const std::string msg = e.what();
        if (msg == "cancelled") return;
        // Offline from the internet but the library server is up to date: that is the answer.
        if (serverCurrent) {
            showError("app/settings/update_none"_i18n);
            return;
        }
        showError(serverError.empty() ? msg : serverError + "\n\n" + msg);
    }
}

#endif

} // namespace

SettingsTab::SettingsTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    auto& session = Session::instance();
    setHeader(dynamic_cast<brls::Header*>(this->getView("header")), "app/tabs/settings"_i18n, 0);
    setStatusLine(dynamic_cast<brls::Label*>(this->getView("status")), "");
    if (!list) return;

    list->addView(makeHeader("app/settings/server"_i18n));
    if (session.settings.useUsb) {
        list->addView(makeInfoCell("app/connect/address"_i18n, "app/connect/usb"_i18n));
    } else {
        auto* url = new brls::InputCell();
        url->init("app/connect/address"_i18n, session.settings.url, [](std::string text) {
            if (text.empty()) return;
            brls::sync([text] {
                auto& s = Session::instance();
                s.setUrl(text);
                // Same server keeps its token; a different one drops it and needs pairing.
                if (s.hasToken()) enterPairedSession();
                else showScreen(Screen::Pair);
            });
        }, "https://…", "", 80);
        list->addView(url);
    }

    auto* name = new brls::InputCell();
    name->init("app/settings/name"_i18n, session.settings.name, [](std::string text) {
        if (text.empty()) return;
        Session::instance().settings.name = std::move(text);
        Session::instance().settings.save();
    }, "", "", 32);
    list->addView(name);

    list->addView(makeCell("app/settings/repair"_i18n, "", [](brls::View*) {
        brls::Application::pushActivity(new PairActivity());
        return true;
    }));

    list->addView(makeCell("app/settings/forget"_i18n, "", [](brls::View*) {
        auto* dialog = new brls::Dialog("app/settings/forget_confirm"_i18n);
        dialog->addButton("app/settings/forget"_i18n, [] {
            brls::sync([] {
                Session::instance().forgetDevice();
                showScreen(Screen::Connect);
            });
        });
        dialog->addButton("hints/back"_i18n, [] {});
        dialog->open();
        return true;
    }));

    list->addView(makeHeader("app/settings/installs"_i18n));
    int targetSel = 0;
    if (session.settings.defaultTarget == "nand") targetSel = 1;
    else if (session.settings.defaultTarget == "auto") targetSel = 2;
    auto* target = new brls::SelectorCell();
    target->init("app/settings/target"_i18n,
        {"app/storage/sd"_i18n, "app/storage/nand"_i18n, "app/storage/auto"_i18n}, targetSel, [](int i) {
            static const char* k[] = {"sd", "nand", "auto"};
            Session::instance().settings.defaultTarget = k[i];
            Session::instance().settings.save();
        });
    list->addView(target);

    auto* hash = new brls::BooleanCell();
    hash->init("app/settings/verify"_i18n, session.settings.verifyHash, [](bool on) {
        Session::instance().settings.verifyHash = on;
        Session::instance().settings.save();
    });
    list->addView(hash);

    auto* firmware = new brls::BooleanCell();
    firmware->init("app/settings/clear_firmware"_i18n, session.settings.clearFirmwareRequirement, [](bool on) {
        Session::instance().settings.clearFirmwareRequirement = on;
        Session::instance().settings.save();
    });
    list->addView(firmware);

    list->addView(makeHeader("app/settings/app"_i18n));
    list->addView(makeInfoCell("app/settings/version"_i18n, NSLIB_VERSION));
    list->addView(makeCell("app/settings/update"_i18n, "", [](brls::View*) {
#ifdef __SWITCH__
        brls::sync([] { checkForUpdates(); });
#endif
        return true;
    }));
    list->addView(makeInfoCell("app/settings/log"_i18n, fileLogPath()));
}

brls::View* SettingsTab::create() { return new SettingsTab(); }

} // namespace nslib
