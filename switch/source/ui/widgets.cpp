#include "ui/widgets.hpp"

using namespace brls::literals;

namespace nslib {

std::string tr(const std::string& key, const std::string& fallback) {
    return key.empty() ? fallback : brls::getStr(key);
}

brls::Header* makeHeader(const std::string& title, const std::string& detail) {
    auto* header = new brls::Header();
    header->setTitle(title);
    if (!detail.empty()) header->setSubtitle(detail);
    header->setMarginTop(16);
    return header;
}

brls::DetailCell* makeCell(const std::string& title, const std::string& detail,
    std::function<bool(brls::View*)> onClick)
{
    auto* cell = new brls::DetailCell();
    cell->setText(title);
    if (!detail.empty()) cell->setDetailText(detail);
    // Long library names scroll instead of spilling into the detail column.
    cell->title->setSingleLine(true);
    if (onClick) cell->registerClickAction(std::move(onClick));
    return cell;
}

brls::DetailCell* makeInfoCell(const std::string& title, const std::string& detail) {
    auto* cell = makeCell(title, detail);
    cell->setDetailTextColor(brls::Application::getTheme()["brls/text_disabled"]);
    return cell;
}

brls::Box* makeEmptyState(const std::string& text) {
    auto* box = new brls::Box(brls::Axis::COLUMN);
    box->setAlignItems(brls::AlignItems::CENTER);
    box->setJustifyContent(brls::JustifyContent::CENTER);
    box->setPadding(60, 40, 60, 40);
    box->setGrow(1.0f);

    auto* label = new brls::Label();
    label->setText(text);
    label->setHorizontalAlign(brls::HorizontalAlign::CENTER);
    label->setTextColor(brls::Application::getTheme()["brls/text_disabled"]);
    box->addView(label);
    return box;
}

void setStatusLine(brls::Label* status, const std::string& text) {
    if (!status) return;
    status->setText(text);
    status->setTextColor(brls::Application::getTheme()["brls/text_disabled"]);
    status->setVisibility(text.empty() ? brls::Visibility::GONE : brls::Visibility::VISIBLE);
}

void setHeader(brls::Header* header, const std::string& title, size_t count) {
    if (!header) return;
    header->setTitle(title);
    header->setSubtitle(count ? std::to_string(count) : "");
}

} // namespace nslib
