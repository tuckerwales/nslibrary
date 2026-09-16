#include "ui/main_activity.hpp"

#include "app/session.hpp"
#include "ui/detail.hpp"

#include <borealis.hpp>
#include <unordered_map>

using namespace brls::literals;

namespace nslib {

UpdatesTab::UpdatesTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    auto* status = dynamic_cast<brls::Label*>(this->getView("status"));
    if (status) status->setText("app/updates/intro"_i18n);
    if (!list) return;

    std::unordered_map<std::string, uint32_t> installed;
    for (const auto& t : Session::instance().installedSnapshot().titles) {
        if (t.type == "patch" || t.type == "application") {
            auto it = installed.find(t.titleId);
            if (it == installed.end() || t.version > it->second) installed[t.titleId] = t.version;
        }
    }

    for (const auto& app : Session::instance().catalogSnapshot()) {
        if (app.updates.empty()) continue;
        const uint32_t newest = app.updates.front().version;
        uint32_t have = 0;
        auto it = installed.find(app.id);
        if (it != installed.end()) have = it->second;
        if (have >= newest && have != 0) continue;

        auto* cell = new brls::DetailCell();
        cell->setText(app.name);
        cell->setDetailText("v" + std::to_string(newest));
        cell->registerClickAction([app](brls::View*) {
            brls::Application::pushActivity(new TitleDetailActivity(app));
            return true;
        });
        list->addView(cell);
    }
}

brls::View* UpdatesTab::create() { return new UpdatesTab(); }

} // namespace nslib
