#include "test.hpp"
#include "ui/library_sort.hpp"

#include <optional>
#include <vector>

using namespace nslib;

namespace {

CatalogApp app(const std::string& id, const std::string& name, std::optional<int64_t> addedAt) {
    CatalogApp a;
    a.id = id;
    a.name = name;
    a.addedAt = addedAt;
    return a;
}

std::vector<std::string> ids(const std::vector<CatalogApp>& apps) {
    std::vector<std::string> out;
    for (const auto& a : apps) out.push_back(a.id);
    return out;
}

std::vector<CatalogApp> sample() {
    // In title ID order, the way the server sends them.
    return {
        app("0100000000010000", "zelda", 300),
        app("0100000000020000", "Animal Crossing", 100),
        app("0100000000030000", "Mario (EU) (5.00 GB)", 200),
        app("0100000000040000", "", 200),
        app("0100000000050000", "Metroid", 200),
    };
}

} // namespace

TEST(library_sort_by_name_ignores_case_and_the_size_suffix) {
    auto apps = sample();
    sortCatalog(apps, LibrarySort::Name);
    // A title with no name sorts by its ID, as the grid shows it.
    CHECK(ids(apps) == (std::vector<std::string>{"0100000000040000", "0100000000020000", "0100000000030000",
                           "0100000000050000", "0100000000010000"}));
}

TEST(library_sort_by_date_added_breaks_ties_by_name) {
    auto newest = sample();
    sortCatalog(newest, LibrarySort::AddedDesc);
    CHECK(ids(newest) == (std::vector<std::string>{"0100000000010000", "0100000000040000", "0100000000030000",
                             "0100000000050000", "0100000000020000"}));

    auto oldest = sample();
    sortCatalog(oldest, LibrarySort::AddedAsc);
    CHECK(ids(oldest) == (std::vector<std::string>{"0100000000020000", "0100000000040000", "0100000000030000",
                             "0100000000050000", "0100000000010000"}));
}

TEST(library_sort_ids_round_trip_and_unknown_ones_read_as_name) {
    for (auto sort : {LibrarySort::Name, LibrarySort::AddedDesc, LibrarySort::AddedAsc}) {
        CHECK(parseLibrarySort(librarySortId(sort)) == sort);
    }
    CHECK(parseLibrarySort("") == LibrarySort::Name);
    CHECK(parseLibrarySort("size") == LibrarySort::Name);
    CHECK_EQ(librarySortId(LibrarySort::AddedDesc), std::string("added-desc"));
}

TEST(library_sort_without_dates_stays_on_name) {
    std::vector<CatalogApp> old = {app("0100000000010000", "B", std::nullopt), app("0100000000020000", "A", std::nullopt)};
    CHECK(!catalogHasDates(old));
    CHECK(catalogHasDates(sample()));
    // A saved date order is kept but not applied against a server that sends no dates.
    CHECK(effectiveLibrarySort(LibrarySort::AddedDesc, false) == LibrarySort::Name);
    CHECK(effectiveLibrarySort(LibrarySort::AddedDesc, true) == LibrarySort::AddedDesc);
    CHECK(nextLibrarySort(LibrarySort::Name, false) == LibrarySort::Name);

    CHECK(nextLibrarySort(LibrarySort::Name, true) == LibrarySort::AddedDesc);
    CHECK(nextLibrarySort(LibrarySort::AddedDesc, true) == LibrarySort::AddedAsc);
    CHECK(nextLibrarySort(LibrarySort::AddedAsc, true) == LibrarySort::Name);
}
