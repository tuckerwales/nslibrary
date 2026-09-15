#include "ui/pair.hpp"

#include "app/session.hpp"
#include "ui/main_activity.hpp"
#include "ui/widgets.hpp"

#include <borealis.hpp>
#include <cstdio>

using namespace brls::literals;

namespace nslib {

brls::View* PairActivity::createContentView() {
    auto* box = new brls::Box(brls::Axis::COLUMN);
    box->setPadding(20, 40, 30, 40);

    auto* intro = new brls::Label();
    intro->setText("app/pair/intro"_i18n);
    intro->setFontSize(18);
    intro->setTextColor(brls::Application::getTheme()["brls/text_disabled"]);
    box->addView(intro);

    box->addView(makeHeader("app/pair/code"_i18n));
    box->addView(makeCell("app/pair/enter"_i18n, "", [](brls::View*) {
        brls::Application::getImeManager()->openForNumber(
            [](long number) {
                char buf[8];
                std::snprintf(buf, sizeof(buf), "%06ld", number);
                const std::string code = buf;
                // swkbd is still open until this callback returns. Do the HTTP
                // and activity push on the next frame, after swkbdClose.
                brls::sync([code] {
                    try {
                        brls::Logger::info("pair submit");
                        Session::instance().pair(code);
                        enterPairedSession();
                    } catch (const std::exception& e) {
                        brls::Logger::error("pair failed: {}", e.what());
                        showError(e.what());
                    }
                });
            },
            "app/pair/enter"_i18n, "", 6);
        return true;
    }));

    const std::string url = Session::instance().settings.url;
    box->addView(makeHeader("app/pair/server"_i18n));
    box->addView(makeInfoCell("app/connect/address"_i18n, url.empty() ? "app/connect/usb"_i18n : url));
    box->addView(makeCell("app/connect/change"_i18n, "", [](brls::View*) {
        showScreen(Screen::Connect);
        return true;
    }));

    auto* scroll = new brls::ScrollingFrame();
    scroll->setContentView(box);
    auto* frame = new brls::AppletFrame(scroll);
    frame->setTitle("app/pair/title"_i18n);
    return frame;
}

} // namespace nslib
