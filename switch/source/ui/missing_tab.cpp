#include "ui/main_activity.hpp"

#include "app/session.hpp"
#include "ui/detail.hpp"

#include <borealis.hpp>
#include <unordered_set>

using namespace brls::literals;

namespace nslib {

MissingTab::MissingTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    rebuild();
}

void MissingTab::rebuild() {
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    auto* status = dynamic_cast<brls::Label*>(this->getView("status"));
    if (status) status->setText("app/missing/intro"_i18n);
    if (!list) return;

    std::unordered_set<std::string> installed;
    for (const auto& t : Session::instance().installedSnapshot().titles) {
        if (t.type == "application") installed.insert(t.titleId);
    }
    const auto catalog = Session::instance().catalogSnapshot();

    replaceChildren(list, [&](brls::Box* box) {
        int shown = 0;
        for (const auto& app : catalog) {
            if (!app.base) continue;
            if (installed.count(app.id)) continue;
            auto* cell = new brls::DetailCell();
            cell->setText(app.name.empty() ? app.id : app.name);
            cell->setDetailText(app.id);
            cell->registerClickAction([app](brls::View*) {
                brls::Application::pushActivity(new TitleDetailActivity(app));
                return true;
            });
            box->addView(cell);
            shown++;
        }
        if (shown == 0) {
            auto* empty = new brls::Label();
            empty->setText("app/missing/empty"_i18n);
            box->addView(empty);
        }
    });
}

brls::View* MissingTab::create() { return new MissingTab(); }

} // namespace nslib
