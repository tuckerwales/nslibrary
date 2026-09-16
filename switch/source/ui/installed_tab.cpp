#include "ui/main_activity.hpp"

#include "app/session.hpp"
#include "installed/compare.hpp"

#include <borealis.hpp>
#include <unordered_map>

using namespace brls::literals;

namespace nslib {

InstalledTab::InstalledTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    rebuild();
}

void InstalledTab::rebuild() {
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    auto* status = dynamic_cast<brls::Label*>(this->getView("status"));
    const auto state = Session::instance().installedSnapshot();
    if (status) {
        std::string line = state.fw + "  AMS " + state.ams;
        if (state.sd) {
            line += "  SD " + std::to_string(state.sd->free / (1024 * 1024)) + " MB free";
        }
        status->setText(line);
    }
    if (!list) return;

    std::unordered_map<std::string, std::string> names;
    for (const auto& app : Session::instance().catalogSnapshot()) {
        if (!app.name.empty()) names[app.id] = app.name;
    }

    replaceChildren(list, [&](brls::Box* box) {
        for (const auto& t : state.titles) {
            const std::string key = t.type == "patch" ? baseTitleIdForPatch(t.titleId) : t.titleId;
            auto it = names.find(key);
            auto* cell = new brls::DetailCell();
            cell->setText(it == names.end() ? t.titleId : it->second);
            cell->setDetailText(t.type + "  v" + std::to_string(t.version) + "  " + t.storage);
            box->addView(cell);
        }
    });
}

brls::View* InstalledTab::create() { return new InstalledTab(); }

} // namespace nslib
