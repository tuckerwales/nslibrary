#include "ui/main_activity.hpp"

#include "app/session.hpp"
#include "ui/detail.hpp"
#include "ui/format.hpp"
#include "ui/widgets.hpp"

#include <borealis.hpp>
#include <unordered_set>
#include <vector>

using namespace brls::literals;

namespace nslib {

MissingTab::MissingTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    rebuild();
}

void MissingTab::rebuild() {
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));

    std::unordered_set<std::string> installed;
    for (const auto& t : Session::instance().installedSnapshot().titles) {
        if (t.type == "application") installed.insert(t.titleId);
    }
    std::vector<CatalogApp> missing;
    for (const auto& app : Session::instance().catalogSnapshot()) {
        if (!app.base) continue;
        if (installed.count(app.id)) continue;
        missing.push_back(app);
    }

    setHeader(dynamic_cast<brls::Header*>(this->getView("header")), "app/tabs/missing"_i18n, missing.size());
    setStatusLine(dynamic_cast<brls::Label*>(this->getView("status")),
        missing.empty() ? "" : "app/missing/intro"_i18n);
    if (!list) return;

    replaceChildren(list, [&](brls::Box* box) {
        if (missing.empty()) {
            box->addView(makeEmptyState("app/missing/empty"_i18n));
            return;
        }
        for (const auto& app : missing) {
            const std::string detail = app.base ? formatSize(app.base->size) : app.id;
            box->addView(makeCell(cleanTitleName(app.name.empty() ? app.id : app.name), detail, [app](brls::View*) {
                brls::Application::pushActivity(new TitleDetailActivity(app));
                return true;
            }));
        }
    });
}

brls::View* MissingTab::create() { return new MissingTab(); }

} // namespace nslib
