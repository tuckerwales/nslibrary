#pragma once

#include "formats/pfs0.hpp"

#include <map>
#include <string>

namespace nslib {

struct XciInfo {
    uint64_t cardOffset = 0;
    Hfs0Partition root;
    std::map<std::string, Hfs0Partition> partitions;
    Hfs0Partition secure;
};

/** Parse an XCI/XCZ card: HEAD at 0x100 or 0x1100, then root HFS0, then the `secure` partition. */
XciInfo parseXci(const Reader& reader);

} // namespace nslib
