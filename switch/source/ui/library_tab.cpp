#include "ui/main_activity.hpp"

#include "app/session.hpp"
#include "ui/detail.hpp"
#include "ui/icon_cache.hpp"

#include <atomic>
#include <borealis.hpp>
#include <memory>

using namespace brls::literals;

namespace nslib {
namespace {

constexpr int kCols = 5;
constexpr float kCellW = 210;
constexpr float kCellH = 230;
constexpr float kIcon = 128;

class TitleCell : public brls::Box {
public:
    explicit TitleCell(CatalogApp app)
        : brls::Box(brls::Axis::COLUMN), app_(std::move(app)), alive_(std::make_shared<std::atomic<bool>>(true))
    {
        this->setWidth(kCellW);
        this->setHeight(kCellH);
        this->setAlignItems(brls::AlignItems::CENTER);
        this->setJustifyContent(brls::JustifyContent::FLEX_START);
        this->setFocusable(true);
        this->setPadding(8);

        auto* img = new brls::Image();
        img->setWidth(kIcon);
        img->setHeight(kIcon);
        img->setScalingType(brls::ImageScalingType::FILL);
        this->addView(img);
        loadAppIcon(img, alive_, app_.id, app_.iconRev);

        auto* label = new brls::Label();
        label->setText(app_.name.empty() ? app_.id : app_.name);
        label->setHorizontalAlign(brls::HorizontalAlign::CENTER);
        this->addView(label);

        this->registerClickAction([this](brls::View*) {
            brls::Application::pushActivity(new TitleDetailActivity(app_));
            return true;
        });
    }

    ~TitleCell() override { alive_->store(false); }

private:
    CatalogApp app_;
    std::shared_ptr<std::atomic<bool>> alive_;
};

} // namespace

LibraryTab::LibraryTab() {
    this->inflateFromXMLRes("xml/tabs/library.xml");
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    auto* status = dynamic_cast<brls::Label*>(this->getView("status"));
    if (status) status->setText(Session::instance().status());
    if (!list) return;

    const auto apps = Session::instance().catalogSnapshot();
    if (apps.empty()) {
        auto* empty = new brls::Label();
        empty->setText("app/library/empty"_i18n);
        list->addView(empty);
        return;
    }

    brls::Box* row = nullptr;
    int col = 0;
    for (const auto& app : apps) {
        if (!row || col == kCols) {
            row = new brls::Box(brls::Axis::ROW);
            list->addView(row);
            col = 0;
        }
        row->addView(new TitleCell(app));
        col++;
    }
}

brls::View* LibraryTab::create() { return new LibraryTab(); }

} // namespace nslib
