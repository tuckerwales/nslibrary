#include "ui/main_activity.hpp"

#include "app/session.hpp"

#include <borealis.hpp>
#include <cstdio>

using namespace brls::literals;

namespace nslib {

QueueTab::QueueTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    auto* status = dynamic_cast<brls::Label*>(this->getView("status"));
    auto& session = Session::instance();
    if (status) {
        auto p = session.progressSnapshot();
        if (session.isInstalling() && !p.phase.empty()) {
            char buf[160];
            std::snprintf(buf, sizeof(buf), "%s  %llu / %llu", p.phase.c_str(),
                static_cast<unsigned long long>(p.done), static_cast<unsigned long long>(p.total));
            status->setText(buf);
        } else {
            status->setText(session.status());
        }
    }
    if (!list) return;

    const auto jobs = session.jobsSnapshot();
    if (jobs.empty()) {
        auto* empty = new brls::Label();
        empty->setText("app/queue/empty"_i18n);
        list->addView(empty);
        return;
    }
    for (const auto& job : jobs) {
        auto* cell = new brls::DetailCell();
        cell->setText(job.name);
        std::string detail = job.status + "  " + job.format + "  " + job.target;
        cell->setDetailText(detail);
        cell->registerClickAction([job](brls::View*) {
            if (job.status == "done" || job.status == "failed" || job.status == "cancelled") return true;
            auto* dialog = new brls::Dialog("app/queue/cancel"_i18n + std::string("\n") + job.name);
            dialog->addButton("hints/ok"_i18n, [id = job.id]() { Session::instance().cancelJob(id); });
            dialog->addButton("hints/cancel"_i18n, []() {});
            dialog->open();
            return true;
        });
        list->addView(cell);
    }
}

brls::View* QueueTab::create() { return new QueueTab(); }

} // namespace nslib
