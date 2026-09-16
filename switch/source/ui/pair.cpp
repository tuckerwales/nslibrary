#include "ui/pair.hpp"

#include "app/session.hpp"
#include "ui/main_activity.hpp"

#include <borealis.hpp>
#include <cstdio>

using namespace brls::literals;

namespace nslib {

brls::View* PairActivity::createContentView() {
    auto* box = new brls::Box(brls::Axis::COLUMN);
    box->setPadding(40);
    auto* intro = new brls::Label();
    intro->setText("app/pair/intro"_i18n);
    box->addView(intro);

    auto* cell = new brls::DetailCell();
    cell->setText("app/pair/enter"_i18n);
    cell->registerClickAction([](brls::View*) {
        brls::Application::getImeManager()->openForNumber(
            [](long number) {
                char buf[8];
                std::snprintf(buf, sizeof(buf), "%06ld", number);
                try {
                    Session::instance().pair(buf);
                    enterPairedSession();
                } catch (const std::exception& e) {
                    showError(e.what());
                }
            },
            "app/pair/enter"_i18n, "", 6);
        return true;
    });
    box->addView(cell);

    auto* scroll = new brls::ScrollingFrame();
    scroll->setContentView(box);
    auto* frame = new brls::AppletFrame(scroll);
    frame->setTitle("app/pair/title"_i18n);
    return frame;
}

} // namespace nslib
