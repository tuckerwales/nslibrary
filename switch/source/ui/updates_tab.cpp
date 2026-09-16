#include "ui/main_activity.hpp"

#include "app/session.hpp"

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
        const int64_t id = app.updates.front().contentMetaId;
        cell->registerClickAction([app, id](brls::View*) {
            auto* dialog = new brls::Dialog("app/library/install"_i18n + std::string("\n") + app.name);
            dialog->addButton("hints/ok"_i18n, [id]() { Session::instance().queueInstall(id, "sd"); });
            dialog->addButton("hints/cancel"_i18n, []() {});
            dialog->open();
            return true;
        });
        list->addView(cell);
    }
}

brls::View* UpdatesTab::create() { return new UpdatesTab(); }

} // namespace nslib
