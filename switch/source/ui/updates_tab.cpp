#include "ui/main_activity.hpp"

#include "app/session.hpp"
#include "installed/compare.hpp"
#include "ui/detail.hpp"

#include <borealis.hpp>

using namespace brls::literals;

namespace nslib {

UpdatesTab::UpdatesTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    rebuild();
}

void UpdatesTab::rebuild() {
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    auto* status = dynamic_cast<brls::Label*>(this->getView("status"));
    if (status) status->setText("app/updates/intro"_i18n);
    if (!list) return;

    const auto catalog = Session::instance().catalogSnapshot();
    const auto installed = Session::instance().installedSnapshot();
    const auto updates = findUpdates(catalog, installed.titles);

    replaceChildren(list, [&](brls::Box* box) {
        if (updates.empty()) {
            auto* empty = new brls::Label();
            empty->setText("app/updates/empty"_i18n);
            box->addView(empty);
            return;
        }
        for (const auto& u : updates) {
            const CatalogApp app = *u.app;
            auto* cell = new brls::DetailCell();
            cell->setText(app.name.empty() ? app.id : app.name);
            cell->setDetailText("v" + std::to_string(u.installed) + " → v" + std::to_string(u.newest));
            cell->registerClickAction([app](brls::View*) {
                brls::Application::pushActivity(new TitleDetailActivity(app));
                return true;
            });
            box->addView(cell);
        }
    });
}

brls::View* UpdatesTab::create() { return new UpdatesTab(); }

} // namespace nslib
