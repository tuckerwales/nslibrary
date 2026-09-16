#include "ui/main_activity.hpp"

#include "app/session.hpp"

#include <borealis.hpp>

using namespace brls::literals;

namespace nslib {

InstalledTab::InstalledTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
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
    for (const auto& t : state.titles) {
        auto* cell = new brls::DetailCell();
        cell->setText(t.titleId);
        cell->setDetailText(t.type + "  v" + std::to_string(t.version) + "  " + t.storage);
        list->addView(cell);
    }
}

brls::View* InstalledTab::create() { return new InstalledTab(); }

} // namespace nslib
