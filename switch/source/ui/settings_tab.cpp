#include "ui/main_activity.hpp"

#include "app/file_log.hpp"
#include "app/session.hpp"
#include "ui/connect.hpp"
#include "ui/pair.hpp"

#include <borealis.hpp>
#include <string>
#include <thread>

using namespace brls::literals;

namespace nslib {

SettingsTab::SettingsTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    auto* status = dynamic_cast<brls::Label*>(this->getView("status"));
    auto& session = Session::instance();
    if (status) status->setText(session.settings.url);
    if (!list) return;

    auto* url = new brls::InputCell();
    url->init("app/settings/url"_i18n, session.settings.url, [](std::string text) {
        Session::instance().setUrl(std::move(text));
        if (Session::instance().hasToken()) enterPairedSession();
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
        Session::instance().forgetDevice();
        brls::Application::pushActivity(new ConnectActivity());
        return true;
    });
    list->addView(forget);

    auto* ver = new brls::DetailCell();
    ver->setText("app/settings/version"_i18n);
    ver->setDetailText(NSLIB_VERSION);
    list->addView(ver);

    auto* log = new brls::DetailCell();
    log->setText("Log file");
    log->setDetailText(fileLogPath());
    list->addView(log);

    auto* update = new brls::DetailCell();
    update->setText("app/settings/update"_i18n);
    update->setDetailText(NSLIB_VERSION);
    update->registerClickAction([](brls::View*) {
#ifdef __SWITCH__
        brls::Application::notify("app/settings/update_checking"_i18n);
        std::thread([] {
            try {
                const auto found = Session::instance().checkGithubUpdate();
                brls::sync([found] {
                    if (!found.newer) {
                        showError("app/settings/update_none"_i18n);
                        return;
                    }
                    auto* dialog = new brls::Dialog(
                        std::string("app/settings/update_available"_i18n) + "\n" + found.manifest.version);
                    dialog->addButton("hints/ok"_i18n, [found] {
                        std::thread([found] {
                            try {
                                Session::instance().installGithubUpdate(found);
                                brls::sync([] { brls::Application::notify("app/settings/update_done"_i18n); });
                            } catch (const std::exception& e) {
                                brls::sync([msg = std::string(e.what())] { showError(msg); });
                            }
                        }).detach();
                    });
                    dialog->addButton("hints/cancel"_i18n, [] {});
                    dialog->open();
                });
            } catch (const std::exception& e) {
                const std::string msg = e.what();
                brls::sync([msg] {
                    if (!Session::instance().canUpdate()) {
                        showError(msg);
                        return;
                    }
                    auto* dialog = new brls::Dialog("app/settings/update_github_failed"_i18n);
                    dialog->addButton("hints/ok"_i18n, [] {
                        std::thread([] {
                            try {
                                Session::instance().applyServerUpdate();
                                brls::sync([] { brls::Application::notify("app/settings/update_done"_i18n); });
                            } catch (const std::exception& e) {
                                brls::sync([msg = std::string(e.what())] { showError(msg); });
                            }
                        }).detach();
                    });
                    dialog->addButton("hints/cancel"_i18n, [] {});
                    dialog->open();
                });
            }
        }).detach();
#else
        (void)0;
#endif
        return true;
    });
    list->addView(update);
}

brls::View* SettingsTab::create() { return new SettingsTab(); }

void showError(const std::string& message) {
    auto* dialog = new brls::Dialog(message);
    dialog->addButton("hints/ok"_i18n, []() {});
    dialog->open();
}

void enterPairedSession() {
    auto& session = Session::instance();
    brls::Logger::info("enterPairedSession ready={}", session.isReady());
    if (!session.isReady()) session.setStatus("app/connect/connecting"_i18n);
    brls::Application::pushActivity(new MainActivity());
    brls::Logger::info("MainActivity pushed");
    if (session.isReady()) return;

    // libcurl/mbedTLS on Switch is not safe off the main thread. Pairing already
    // used curl here; hello/catalog/events must stay on this thread too.
    brls::sync([] {
        brls::Logger::info("session start on main");
        try {
            Session::instance().start();
            try {
                Session::instance().refreshInstalled();
            } catch (const std::exception& e) {
                brls::Logger::error("refreshInstalled: {}", e.what());
            } catch (...) {
                brls::Logger::error("refreshInstalled: unknown");
            }
            brls::Logger::info("refresh library tab");
            refreshLibraryTab();
            brls::Logger::info("library tab ready");
        } catch (const ApiError& e) {
            const std::string code = e.code;
            const std::string msg = e.what();
            brls::Logger::error("session ApiError {} {}", code, msg);
            Session::instance().setStatus(msg);
            refreshLibraryTab();
            if (code == "UNAUTHORIZED" || code == "DEVICE_REVOKED") {
                Session::instance().forgetDevice();
                showError(msg);
                brls::Application::pushActivity(new PairActivity());
                return;
            }
            auto* dialog = new brls::Dialog(msg);
            dialog->addButton("hints/ok"_i18n, []() {});
            dialog->addButton("app/connect/change"_i18n, []() {
                brls::Application::pushActivity(new ConnectActivity());
            });
            dialog->open();
        } catch (const std::exception& e) {
            const std::string msg = e.what();
            brls::Logger::error("session error {}", msg);
            Session::instance().setStatus(msg);
            refreshLibraryTab();
            auto* dialog = new brls::Dialog(msg);
            dialog->addButton("hints/ok"_i18n, []() {});
            dialog->addButton("app/connect/change"_i18n, []() {
                brls::Application::pushActivity(new ConnectActivity());
            });
            dialog->open();
        } catch (...) {
            brls::Logger::error("session error unknown");
            Session::instance().setStatus("Connection failed");
            refreshLibraryTab();
            showError("Connection failed");
        }
    });
}

} // namespace nslib
