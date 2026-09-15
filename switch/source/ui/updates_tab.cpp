#include "ui/main_activity.hpp"

#include "app/session.hpp"
#include "installed/compare.hpp"
#include "ui/detail.hpp"
#include "ui/format.hpp"
#include "ui/widgets.hpp"

#include <borealis.hpp>

using namespace brls::literals;

namespace nslib {
namespace {

/** Size of the update the library would install, when the catalog lists it. */
uint64_t updateSize(const CatalogApp& app, uint32_t version) {
    for (const auto& upd : app.updates) {
        if (upd.version == version) return upd.size;
    }
    return 0;
}

} // namespace

UpdatesTab::UpdatesTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    rebuild();
}

void UpdatesTab::rebuild() {
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    const auto catalog = Session::instance().catalogSnapshot();
    const auto installed = Session::instance().installedSnapshot();
    const auto updates = findUpdates(catalog, installed.titles);

    setHeader(dynamic_cast<brls::Header*>(this->getView("header")), "app/tabs/updates"_i18n, updates.size());
    setStatusLine(dynamic_cast<brls::Label*>(this->getView("status")),
        updates.empty() ? "" : "app/updates/intro"_i18n);
    if (!list) return;

    replaceChildren(list, [&](brls::Box* box) {
        if (updates.empty()) {
            box->addView(makeEmptyState("app/updates/empty"_i18n));
            return;
        }
        for (const auto& u : updates) {
            const CatalogApp app = *u.app;
            std::string detail = formatVersion(u.installed) + " → " + formatVersion(u.newest);
            const uint64_t size = updateSize(app, u.newest);
            if (size) detail += "   " + formatSize(size);
            box->addView(makeCell(cleanTitleName(app.name.empty() ? app.id : app.name), detail, [app](brls::View*) {
                brls::Application::pushActivity(new TitleDetailActivity(app));
                return true;
            }));
        }
    });
}

brls::View* UpdatesTab::create() { return new UpdatesTab(); }

} // namespace nslib
