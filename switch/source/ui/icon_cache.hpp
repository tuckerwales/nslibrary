#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace brls {
class Image;
}

namespace nslib {

/** `alive` is cleared when the owning view is destroyed; late downloads are ignored.
 *  Pass `fetchRemote=false` for dense grids so the library screen does not fire
 *  dozens of HTTP GETs (and libcurl/mbedTLS work) right after connect. */
void loadAppIcon(brls::Image* image, std::shared_ptr<std::atomic<bool>> alive, const std::string& appId,
    std::optional<int64_t> rev, bool fetchRemote = true);

} // namespace nslib
