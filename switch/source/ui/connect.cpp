#include "ui/connect.hpp"

#include "app/session.hpp"
#include "transport/discovery.hpp"
#ifdef __SWITCH__
#include "transport/usb.hpp"
#endif
#include "ui/main_activity.hpp"
#include "ui/pair.hpp"
#include "ui/widgets.hpp"

#include <borealis.hpp>
#include <string>

using namespace brls::literals;

namespace nslib {
namespace {

void afterUrl() {
    if (Session::instance().hasToken()) {
        enterPairedSession();
    } else {
        showScreen(Screen::Pair);
    }
}

} // namespace

brls::View* ConnectActivity::createContentView() {
    auto* scroll = new brls::ScrollingFrame();
    auto* box = new brls::Box(brls::Axis::COLUMN);
    box->setPadding(20, 40, 30, 40);
    scroll->setContentView(box);
    auto* frame = new brls::AppletFrame(scroll);
    frame->setTitle("app/connect/title"_i18n);

    auto* intro = new brls::Label();
    intro->setText("app/connect/intro"_i18n);
    intro->setFontSize(18);
    intro->setTextColor(brls::Application::getTheme()["brls/text_disabled"]);
    box->addView(intro);

#ifdef __SWITCH__
    if (UsbTransport::available()) {
        box->addView(makeHeader("app/connect/usb"_i18n));
        box->addView(makeCell("app/connect/usb_connect"_i18n, "app/connect/usb_hint"_i18n, [](brls::View*) {
            brls::sync([] {
                try {
                    Session::instance().usbHello();
                    enterPairedSession();
                } catch (const std::exception& e) {
                    showError(e.what());
                }
            });
            return true;
        }));
    }
#endif

    box->addView(makeHeader("app/connect/lan"_i18n));
    // Discovery results go in their own box so searching again replaces them instead of appending.
    auto* results = new brls::Box(brls::Axis::COLUMN);
    box->addView(makeCell("app/connect/discover"_i18n, "", [results](brls::View*) {
        auto found = discoverServers();
        if (found.empty()) {
            replaceChildren(results, [](brls::Box*) {});
            showError("app/connect/none"_i18n);
            return true;
        }
        replaceChildren(results, [&found](brls::Box* list) {
            for (const auto& s : found) {
                const std::string url = s.url;
                const std::string name = s.reply.name.empty() ? url : s.reply.name;
                list->addView(makeCell(name, url, [url](brls::View*) {
                    brls::sync([url] {
                        Session::instance().setUrl(url);
                        afterUrl();
                    });
                    return true;
                }));
            }
        });
        return true;
    }));
    box->addView(results);

    box->addView(makeHeader("app/connect/by_address"_i18n));
    box->addView(makeCell("app/connect/manual"_i18n, Session::instance().settings.url, [](brls::View* view) {
        auto* cell = static_cast<brls::DetailCell*>(view);
        brls::Application::getImeManager()->openForText(
            [cell](const std::string text) {
                if (text.empty()) return;
                const std::string url = text;
                brls::sync([cell, url] {
                    Session::instance().setUrl(url);
                    cell->setDetailText(Session::instance().settings.url);
                    afterUrl();
                });
            },
            "app/connect/manual"_i18n, "app/connect/hint"_i18n, 80, Session::instance().settings.url);
        return true;
    }));

    frame->registerAction("hints/exit"_i18n, brls::BUTTON_START, [](brls::View*) {
        brls::Application::quit();
        return true;
    });
    return frame;
}

} // namespace nslib
