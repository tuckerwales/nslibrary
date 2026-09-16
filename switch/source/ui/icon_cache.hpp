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
 *  Remote fetches run one per frame on the UI thread and are skipped while the library is unreachable. */
void loadAppIcon(brls::Image* image, std::shared_ptr<std::atomic<bool>> alive, const std::string& appId,
    std::optional<int64_t> rev, bool fetchRemote = true);

} // namespace nslib
