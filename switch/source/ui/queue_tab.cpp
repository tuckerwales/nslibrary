#include "ui/main_activity.hpp"

#include "app/session.hpp"
#include "ui/format.hpp"
#include "ui/widgets.hpp"

#include <borealis.hpp>

using namespace brls::literals;

namespace nslib {
namespace {

/** True while the console still has something to do about this job. */
bool isOpen(const std::string& status) {
    return status != "done" && status != "failed" && status != "cancelled";
}

/** "Copying content   48%   10.8 GB / 22.5 GB   12.4 MB/s   4m 12s left" */
std::string progressLine(const JobProgress& p) {
    std::string line = tr(installPhaseKey(p.phase), p.phase);
    const std::string pct = formatPercent(p.done, p.total);
    if (!pct.empty()) line += "   " + pct;
    if (p.total) line += "   " + formatOfTotal(p.done, p.total);
    const std::string rate = formatRate(p.bps);
    if (!rate.empty()) line += "   " + rate;
    const std::string eta = p.total > p.done ? formatEta(double(p.total - p.done), p.bps) : std::string();
    if (!eta.empty()) line += "   " + brls::getStr("app/queue/left", eta);
    return line;
}

} // namespace

QueueTab::QueueTab() {
    this->inflateFromXMLRes("xml/tabs/list.xml");
    rebuild();
}

void QueueTab::rebuild() {
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    auto& session = Session::instance();
    const auto jobs = session.jobsSnapshot();

    setHeader(dynamic_cast<brls::Header*>(this->getView("header")), "app/tabs/queue"_i18n, jobs.size());

    auto* status = dynamic_cast<brls::Label*>(this->getView("status"));
    if (status) {
        const auto p = session.progressSnapshot();
        const bool running = session.isInstalling() && !p.phase.empty();
        setStatusLine(status, running ? progressLine(p) : session.status());
        status->setTextColor(brls::Application::getTheme()[running ? "brls/accent" : "brls/text_disabled"]);
    }
    if (!list) return;

    replaceChildren(list, [&](brls::Box* box) {
        if (jobs.empty()) {
            box->addView(makeEmptyState("app/queue/empty"_i18n));
            return;
        }
        for (const auto& job : jobs) {
            std::string detail = tr(jobStatusKey(job.status), job.status);
            detail += "   " + tr(storageKey(job.target), job.target);
            auto* cell = makeCell(cleanTitleName(job.name), detail, [job](brls::View*) {
                if (!isOpen(job.status)) return true;
                const bool startable = job.status == "queued" || job.status == "interrupted";
                const char* body = startable ? "app/queue/start" : "app/queue/cancel";
                auto* dialog = new brls::Dialog(brls::getStr(body) + "\n" + cleanTitleName(job.name));
                if (startable) {
                    dialog->addButton("app/queue/start_now"_i18n,
                        [job]() { brls::sync([job] { Session::instance().claimAndInstall(job); }); });
                } else {
                    dialog->addButton("app/queue/cancel_now"_i18n,
                        [id = job.id]() { brls::sync([id] { Session::instance().cancelJob(id); }); });
                }
                dialog->addButton("hints/back"_i18n, []() {});
                dialog->open();
                return true;
            });
            if (!isOpen(job.status)) {
                cell->setDetailTextColor(brls::Application::getTheme()["brls/text_disabled"]);
            }
            box->addView(cell);
        }
    });
}

brls::View* QueueTab::create() { return new QueueTab(); }

} // namespace nslib
