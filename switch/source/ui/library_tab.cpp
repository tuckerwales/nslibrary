#include "ui/main_activity.hpp"

#include "app/session.hpp"

#include <borealis.hpp>
#include <cstdio>

using namespace brls::literals;

namespace nslib {
namespace {

std::string formatAppDetail(const CatalogApp& app) {
    std::string d = app.id;
    if (app.base) d += "  base";
    if (!app.updates.empty()) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "  u%u", app.updates.front().version);
        d += buf;
    }
    if (!app.dlc.empty()) d += "  dlc " + std::to_string(app.dlc.size());
    return d;
}

int64_t defaultMetaId(const CatalogApp& app) {
    if (app.base) return app.base->contentMetaId;
    if (!app.updates.empty()) return app.updates.front().contentMetaId;
    if (!app.dlc.empty()) return app.dlc.front().contentMetaId;
    return 0;
}

} // namespace

LibraryTab::LibraryTab() {
    this->inflateFromXMLRes("xml/tabs/library.xml");
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    auto* status = dynamic_cast<brls::Label*>(this->getView("status"));
    if (status) status->setText(Session::instance().status());
    if (!list) return;

    for (const auto& app : Session::instance().catalogSnapshot()) {
        auto* cell = new brls::DetailCell();
        cell->setText(app.name.empty() ? app.id : app.name);
        cell->setDetailText(formatAppDetail(app));
        cell->registerClickAction([app](brls::View*) {
            const int64_t id = defaultMetaId(app);
            if (!id) {
                showError("app/library/nothing"_i18n);
                return true;
            }
            auto* dialog = new brls::Dialog("app/library/install"_i18n + std::string("\n") + app.name);
            dialog->addButton("hints/ok"_i18n, [id]() { Session::instance().queueInstall(id, "sd"); });
            dialog->addButton("hints/cancel"_i18n, []() {});
            dialog->open();
            return true;
        });
        list->addView(cell);
    }
}

brls::View* LibraryTab::create() { return new LibraryTab(); }

} // namespace nslib
