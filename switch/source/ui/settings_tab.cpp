#include "ui/main_activity.hpp"

#include "app/session.hpp"
#include "ui/connect.hpp"
#include "ui/pair.hpp"

#include <borealis.hpp>

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
    }, "https://…", "", 80);
    list->addView(url);

    auto* name = new brls::InputCell();
    name->init("app/settings/name"_i18n, session.settings.name, [](std::string text) {
        if (text.empty()) return;
        Session::instance().settings.name = std::move(text);
        Session::instance().settings.save();
    }, "", "", 32);
    list->addView(name);

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
}

brls::View* SettingsTab::create() { return new SettingsTab(); }

void showError(const std::string& message) {
    auto* dialog = new brls::Dialog(message);
    dialog->addButton("hints/ok"_i18n, []() {});
    dialog->open();
}

void enterPairedSession() {
    try {
        Session::instance().start();
        brls::Application::pushActivity(new MainActivity());
    } catch (const ApiError& e) {
        if (e.code == "UNAUTHORIZED" || e.code == "DEVICE_REVOKED") {
            Session::instance().forgetDevice();
            showError(e.what());
            brls::Application::pushActivity(new PairActivity());
            return;
        }
        showError(e.what());
    } catch (const std::exception& e) {
        showError(e.what());
    }
}

} // namespace nslib
