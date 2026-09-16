#pragma once

#include "formats/pfs0.hpp"
#include "formats/xci.hpp"

#include <string>

namespace nslib {

/** PFS0 for nsp/nsz, XCI secure partition for xci/xcz. */
Partition listInstallEntries(const Reader& reader, const std::string& format);

} // namespace nslib
