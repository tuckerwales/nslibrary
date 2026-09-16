#include "ui/main_activity.hpp"

#include "app/session.hpp"

#include <borealis.hpp>

using namespace brls::literals;

namespace nslib {

QueueTab::QueueTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    auto* status = dynamic_cast<brls::Label*>(this->getView("status"));
    if (status) status->setText(Session::instance().status());
    if (!list) return;

    const auto jobs = Session::instance().jobsSnapshot();
    if (jobs.empty()) {
        auto* empty = new brls::Label();
        empty->setText("app/queue/empty"_i18n);
        list->addView(empty);
        return;
    }
    for (const auto& job : jobs) {
        auto* cell = new brls::DetailCell();
        cell->setText(job.name);
        cell->setDetailText(job.status + "  " + job.format);
        list->addView(cell);
    }
}

brls::View* QueueTab::create() { return new QueueTab(); }

} // namespace nslib
