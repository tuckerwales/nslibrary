#include "ui/library_sort.hpp"

#include "ui/format.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <utility>

namespace nslib {
namespace {

std::string nameKey(const CatalogApp& app) {
    std::string key = cleanTitleName(app.name.empty() ? app.id : app.name);
    for (auto& c : key) {
        if (c >= 'A' && c <= 'Z') c = char(c - 'A' + 'a');
    }
    return key;
}

} // namespace

LibrarySort parseLibrarySort(const std::string& id) {
    if (id == "added-desc") return LibrarySort::AddedDesc;
    if (id == "added-asc") return LibrarySort::AddedAsc;
    return LibrarySort::Name;
}

std::string librarySortId(LibrarySort sort) {
    switch (sort) {
        case LibrarySort::AddedDesc: return "added-desc";
        case LibrarySort::AddedAsc: return "added-asc";
        case LibrarySort::Name: break;
    }
    return "name";
}

std::string librarySortKey(LibrarySort sort) {
    switch (sort) {
        case LibrarySort::AddedDesc: return "app/library/sort_added_desc";
        case LibrarySort::AddedAsc: return "app/library/sort_added_asc";
        case LibrarySort::Name: break;
    }
    return "app/library/sort_name";
}

bool catalogHasDates(const std::vector<CatalogApp>& apps) {
    return std::any_of(apps.begin(), apps.end(), [](const CatalogApp& app) { return app.addedAt.has_value(); });
}

LibrarySort effectiveLibrarySort(LibrarySort sort, bool hasDates) {
    return hasDates ? sort : LibrarySort::Name;
}

LibrarySort nextLibrarySort(LibrarySort sort, bool hasDates) {
    if (!hasDates) return LibrarySort::Name;
    switch (sort) {
        case LibrarySort::Name: return LibrarySort::AddedDesc;
        case LibrarySort::AddedDesc: return LibrarySort::AddedAsc;
        case LibrarySort::AddedAsc: break;
    }
    return LibrarySort::Name;
}

void sortCatalog(std::vector<CatalogApp>& apps, LibrarySort sort) {
    struct Key {
        int64_t added;
        std::string name;
        size_t index;
    };
    // Work out each key once rather than on every comparison: a big library has thousands of titles.
    std::vector<Key> keys;
    keys.reserve(apps.size());
    for (size_t i = 0; i < apps.size(); i++) keys.push_back({apps[i].addedAt.value_or(0), nameKey(apps[i]), i});

    const auto byName = [&](const Key& a, const Key& b) {
        if (a.name != b.name) return a.name < b.name;
        return apps[a.index].id < apps[b.index].id;
    };
    std::sort(keys.begin(), keys.end(), [&](const Key& a, const Key& b) {
        if (sort != LibrarySort::Name && a.added != b.added) {
            return sort == LibrarySort::AddedDesc ? a.added > b.added : a.added < b.added;
        }
        return byName(a, b);
    });

    std::vector<CatalogApp> sorted;
    sorted.reserve(apps.size());
    for (const auto& key : keys) sorted.push_back(std::move(apps[key.index]));
    apps = std::move(sorted);
}

} // namespace nslib
