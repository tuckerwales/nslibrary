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

/** Loads its icon (SD cache, then the server) the first time it is actually drawn on screen.
 *  Box culls off-screen leaf views, so a large library only touches the visible rows. */
class LazyIcon : public brls::Image {
public:
    LazyIcon(std::shared_ptr<std::atomic<bool>> alive, std::string appId, std::optional<int64_t> rev)
        : alive_(std::move(alive)), appId_(std::move(appId)), rev_(rev) {}

    void draw(NVGcontext* vg, float x, float y, float width, float height, brls::Style style,
        brls::FrameContext* ctx) override
    {
        if (!requested_) {
            requested_ = true;
            loadAppIcon(this, alive_, appId_, rev_, true);
        }
        brls::Image::draw(vg, x, y, width, height, style, ctx);
    }

private:
    std::shared_ptr<std::atomic<bool>> alive_;
    std::string appId_;
    std::optional<int64_t> rev_;
    bool requested_ = false;
};

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

        auto* img = new LazyIcon(alive_, app_.id, app_.iconRev);
        img->setWidth(kIcon);
        img->setHeight(kIcon);
        img->setScalingType(brls::ImageScalingType::FILL);
        this->addView(img);

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

    const std::string& appId() const { return app_.id; }

private:
    CatalogApp app_;
    std::shared_ptr<std::atomic<bool>> alive_;
};

TitleCell* findCell(brls::Box* list, const std::string& appId, size_t skipChildren) {
    const auto& rows = list->getChildren();
    for (size_t i = skipChildren; i < rows.size(); i++) {
        auto* row = dynamic_cast<brls::Box*>(rows[i]);
        if (!row) continue;
        for (auto* child : row->getChildren()) {
            auto* cell = dynamic_cast<TitleCell*>(child);
            if (cell && cell->appId() == appId) return cell;
        }
    }
    return nullptr;
}

} // namespace

LibraryTab::LibraryTab() {
    this->inflateFromXMLRes("xml/tabs/library.xml");
    rebuild(true);
}

void LibraryTab::rebuild(bool force) {
    auto* list = dynamic_cast<brls::Box*>(this->getView("list"));
    auto* status = dynamic_cast<brls::Label*>(this->getView("status"));
    auto& session = Session::instance();
    if (status) {
        std::string line = session.status();
        if (session.isOffline()) line = "Library unreachable. Retrying in the background.";
        status->setText(line.empty() ? "app/connect/connecting"_i18n : line);
    }
    if (!list) return;

    const auto apps = session.catalogSnapshot();
    const int64_t rev = session.catalogRev();
    if (!force && rev == builtRev_ && apps.size() == builtCount_ && !(apps.empty() && session.isReady())) return;
    builtRev_ = rev;
    builtCount_ = apps.size();

    std::string focusedId;
    if (auto* focused = dynamic_cast<TitleCell*>(brls::Application::getCurrentFocus())) focusedId = focused->appId();
    const size_t oldCount = list->getChildren().size();

    replaceChildren(list,
        [&](brls::Box* box) {
            if (apps.empty()) {
                auto* empty = new brls::Label();
                if (session.isReady()) empty->setText("app/library/empty"_i18n);
                else empty->setText(session.status().empty() ? "app/connect/connecting"_i18n : session.status());
                box->addView(empty);
                return;
            }
            brls::Box* row = nullptr;
            int col = 0;
            for (const auto& app : apps) {
                if (!row || col == kCols) {
                    row = new brls::Box(brls::Axis::ROW);
                    box->addView(row);
                    col = 0;
                }
                row->addView(new TitleCell(app));
                col++;
            }
        },
        [&]() -> brls::View* { return focusedId.empty() ? nullptr : findCell(list, focusedId, oldCount); });
}

brls::View* LibraryTab::create() { return new LibraryTab(); }

} // namespace nslib
