#pragma once

#include "api/protocol.hpp"

#include <string>
#include <vector>

namespace nslib {

/** Library grid orders. Saved in settings by the same ids the web UI puts in `?sort=`. */
enum class LibrarySort { Name, AddedDesc, AddedAsc };

/** "name", "added-desc" or "added-asc"; anything else reads as Name. */
LibrarySort parseLibrarySort(const std::string& id);
std::string librarySortId(LibrarySort sort);
/** i18n key for the order's label. */
std::string librarySortKey(LibrarySort sort);

/** True when the server sent dates added. Servers from before sorting did not. */
bool catalogHasDates(const std::vector<CatalogApp>& apps);

/** The order the grid can actually use: Name when the catalog has no dates to sort by. */
LibrarySort effectiveLibrarySort(LibrarySort sort, bool hasDates);

/** The next order the sort button moves to, skipping the date orders without dates. */
LibrarySort nextLibrarySort(LibrarySort sort, bool hasDates);

/**
 * Sorts in place. Names compare as displayed, ignoring ASCII case; ties (a first scan dates
 * every title the same) fall back to name, then application ID, so the order never jitters.
 */
void sortCatalog(std::vector<CatalogApp>& apps, LibrarySort sort);

} // namespace nslib
