#include "ui/main_activity.hpp"

#include "app/file_log.hpp"
#include "app/session.hpp"
#include "ui/connect.hpp"
#include "ui/pair.hpp"

#include <borealis.hpp>
#include <string>

using namespace brls::literals;

namespace nslib {

namespace {

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

} // namespace

SettingsTab::SettingsTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    auto* status = dynamic_cast<brls::Label*>(this->getView("status"));
    auto& session = Session::instance();
    if (status) status->setText(session.settings.useUsb ? std::string("app/connect/usb"_i18n) : session.settings.url);
    if (!list) return;

    auto* url = new brls::InputCell();
    url->init("app/settings/url"_i18n, session.settings.url, [](std::string text) {
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

    auto* name = new brls::InputCell();
    name->init("app/settings/name"_i18n, session.settings.name, [](std::string text) {
        if (text.empty()) return;
        Session::instance().settings.name = std::move(text);
        Session::instance().settings.save();
    }, "", "", 32);
    list->addView(name);

    int targetSel = 0;
    if (session.settings.defaultTarget == "nand") targetSel = 1;
    else if (session.settings.defaultTarget == "auto") targetSel = 2;
    auto* target = new brls::SelectorCell();
    target->init("app/settings/target"_i18n,
        {"app/detail/sd"_i18n, "app/detail/nand"_i18n, "app/detail/auto"_i18n}, targetSel, [](int i) {
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

    auto* pair = new brls::DetailCell();
    pair->setText("app/settings/repair"_i18n);
    pair->registerClickAction([](brls::View*) {
        brls::Application::pushActivity(new PairActivity());
        return true;
    });
    list->addView(pair);

    auto* forget = new brls::DetailCell();
    forget->setText("app/settings/forget"_i18n);
    forget->registerClickAction([](brls::View*) {
        brls::sync([] {
            Session::instance().forgetDevice();
            showScreen(Screen::Connect);
        });
        return true;
    });
    list->addView(forget);

    auto* ver = new brls::DetailCell();
    ver->setText("app/settings/version"_i18n);
    ver->setDetailText(NSLIB_VERSION);
    list->addView(ver);

    auto* log = new brls::DetailCell();
    log->setText("app/settings/log"_i18n);
    log->setDetailText(fileLogPath());
    list->addView(log);

    auto* update = new brls::DetailCell();
    update->setText("app/settings/update"_i18n);
    update->setDetailText(NSLIB_VERSION);
    update->registerClickAction([](brls::View*) {
#ifdef __SWITCH__
        brls::sync([] { checkForUpdates(); });
#endif
        return true;
    });
    list->addView(update);
}

brls::View* SettingsTab::create() { return new SettingsTab(); }

} // namespace nslib
