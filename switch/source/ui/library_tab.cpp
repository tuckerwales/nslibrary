#include "ui/main_activity.hpp"

#include "app/session.hpp"
#include "installed/compare.hpp"
#include "ui/detail.hpp"
#include "ui/format.hpp"
#include "ui/icon_cache.hpp"
#include "ui/widgets.hpp"

#include <atomic>
#include <borealis.hpp>
#include <memory>

using namespace brls::literals;

namespace nslib {
namespace {

constexpr float kCellW = 190;
constexpr float kCellH = 228;
constexpr float kArt = 150;
constexpr float kSidePadding = 30;
/** Room the scrolling frame keeps for its indicator, matching the list padding in library.xml. */
constexpr float kScrollbar = 20;
constexpr float kCellPad = 8;
/** Text may run the full width of the cell, which is wider than the artwork. */
constexpr float kTextW = kCellW - 2 * kCellPad;

/** As many whole cells as the tab content area fits, so nothing hangs off the right edge. */
int gridColumns() {
    const float content = brls::Application::contentWidth > 0 ? brls::Application::contentWidth : 1280;
    const float sidebar = brls::Application::getStyle()["brls/tab_frame/sidebar_width"];
    const int cols = int((content - sidebar - 2 * kSidePadding - kScrollbar) / kCellW);
    return cols < 1 ? 1 : cols;
}

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
    TitleCell(CatalogApp app, const std::string& subtitle, bool installed)
        : brls::Box(brls::Axis::COLUMN), app_(std::move(app)), alive_(std::make_shared<std::atomic<bool>>(true))
    {
        this->setWidth(kCellW);
        this->setHeight(kCellH);
        this->setAlignItems(brls::AlignItems::CENTER);
        this->setJustifyContent(brls::JustifyContent::FLEX_START);
        this->setFocusable(true);
        this->setPadding(10, kCellPad, 10, kCellPad);
        this->setCornerRadius(10);
        this->setHighlightCornerRadius(10);

        // A plain tile sits under the artwork so a title with no icon yet still reads as a card.
        auto* art = new brls::Box();
        art->setWidth(kArt);
        art->setHeight(kArt);
        art->setCornerRadius(8);
        art->setBackgroundColor(brls::Application::getTheme()["brls/sidebar/background"]);
        auto* img = new LazyIcon(alive_, app_.id, app_.iconRev);
        img->setWidth(kArt);
        img->setHeight(kArt);
        img->setCornerRadius(8);
        img->setScalingType(brls::ImageScalingType::FILL);
        art->addView(img);
        this->addView(art);

        // Left-aligned inside a box the cell centres: Borealis only works out where the ellipsis
        // goes for left-aligned text, and a label no wider than its text still sits centred.
        auto* label = new brls::Label();
        label->setText(cleanTitleName(app_.name.empty() ? app_.id : app_.name));
        label->setFontSize(18);
        // One line, ellipsised, so every cell in a row stays the same height.
        label->setSingleLine(true);
        label->setMaxWidth(kTextW);
        label->setMarginTop(10);
        this->addView(label);

        auto* detail = new brls::Label();
        detail->setText(subtitle);
        detail->setFontSize(15);
        detail->setSingleLine(true);
        detail->setMaxWidth(kTextW);
        detail->setMarginTop(4);
        detail->setTextColor(brls::Application::getTheme()[installed ? "brls/accent" : "brls/text_disabled"]);
        this->addView(detail);

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

/** The line under a title: what is on this console, or what installing it would cost. */
std::string cellSubtitle(const CatalogApp& app, const InstalledSummary* state) {
    if (state && state->baseInstalled) {
        std::string line = "app/detail/installed"_i18n;
        if (state->patchVersion) line += "   " + formatVersion(state->patchVersion);
        return line;
    }
    if (app.base) return formatSize(app.base->size);
    if (!app.updates.empty()) return "app/type/patch"_i18n;
    if (!app.dlc.empty()) return "app/type/addon"_i18n;
    return cleanTitleName(app.publisher);
}

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
    auto& session = Session::instance();
    const auto apps = session.catalogSnapshot();
    const auto installed = session.installedSnapshot();

    setHeader(dynamic_cast<brls::Header*>(this->getView("header")), "app/tabs/library"_i18n, apps.size());

    auto* status = dynamic_cast<brls::Label*>(this->getView("status"));
    if (status) {
        std::string line;
        if (session.isOffline()) line = "app/connect/offline"_i18n;
        else if (!session.isReady()) line = session.status().empty() ? "app/connect/connecting"_i18n : session.status();
        setStatusLine(status, line);
        status->setTextColor(brls::Application::getTheme()[session.isOffline() ? "brls/text" : "brls/text_disabled"]);
    }
    if (!list) return;

    const int64_t rev = session.catalogRev();
    const size_t installedCount = installed.titles.size();
    if (!force && rev == builtRev_ && apps.size() == builtCount_ && installedCount == builtInstalled_ &&
        !(apps.empty() && session.isReady()))
        return;
    builtRev_ = rev;
    builtCount_ = apps.size();
    builtInstalled_ = installedCount;

    std::string focusedId;
    if (auto* focused = dynamic_cast<TitleCell*>(brls::Application::getCurrentFocus())) focusedId = focused->appId();
    const size_t oldCount = list->getChildren().size();
    const int cols = gridColumns();
    // One pass over the installed titles, not one per cell: a big library rebuilds without a stutter.
    const auto byApp = summarizeInstalledByApp(installed.titles);

    replaceChildren(list,
        [&](brls::Box* box) {
            if (apps.empty()) {
                if (session.isReady()) {
                    box->addView(makeEmptyState("app/library/empty"_i18n));
                } else {
                    const std::string line = session.status().empty() ? "app/connect/connecting"_i18n : session.status();
                    box->addView(makeEmptyState(line));
                }
                return;
            }
            brls::Box* row = nullptr;
            int col = 0;
            for (const auto& app : apps) {
                if (!row || col == cols) {
                    row = new brls::Box(brls::Axis::ROW);
                    row->setJustifyContent(brls::JustifyContent::FLEX_START);
                    box->addView(row);
                    col = 0;
                }
                const InstalledSummary* state = findInstalled(byApp, app.id);
                row->addView(new TitleCell(app, cellSubtitle(app, state), state && state->baseInstalled));
                col++;
            }
        },
        [&]() -> brls::View* { return focusedId.empty() ? nullptr : findCell(list, focusedId, oldCount); });
}

brls::View* LibraryTab::create() { return new LibraryTab(); }

} // namespace nslib
