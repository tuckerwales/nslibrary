#pragma once

#include <borealis.hpp>
#include <functional>
#include <string>

namespace nslib {

/** Translated text for `key`, or `fallback` when this client has no key for the value. */
std::string tr(const std::string& key, const std::string& fallback);

/** Section header: title on the left, a count or hint on the right, separator underneath. */
brls::Header* makeHeader(const std::string& title, const std::string& detail = "");

/** Standard list row. `onClick` may be empty for a row that only states something. */
brls::DetailCell* makeCell(const std::string& title, const std::string& detail = "",
    std::function<bool(brls::View*)> onClick = {});

/** Row whose detail text is muted rather than accented: a fact about the console, not an action. */
brls::DetailCell* makeInfoCell(const std::string& title, const std::string& detail);

/** Centred, muted paragraph shown in place of a list with nothing in it. */
brls::Box* makeEmptyState(const std::string& text);

/** Show `text`, or hide the label and the gap it leaves when there is nothing to say. */
void setStatusLine(brls::Label* status, const std::string& text);

/** "Library" / "128", with the count left off when the list is empty. */
void setHeader(brls::Header* header, const std::string& title, size_t count);

} // namespace nslib
