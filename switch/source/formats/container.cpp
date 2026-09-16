#include "formats/container.hpp"

namespace nslib {

Partition listInstallEntries(const Reader& reader, const std::string& format) {
    if (format == "nsp" || format == "nsz") return parsePfs0(reader);
    if (format == "xci" || format == "xcz") return toPartition(parseXci(reader).secure);
    throw FormatError("UNSUPPORTED", "unsupported format " + format);
}

} // namespace nslib
