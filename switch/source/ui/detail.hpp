#pragma once

#include "api/protocol.hpp"

#include <atomic>
#include <borealis.hpp>
#include <memory>
#include <optional>

namespace nslib {

class TitleDetailActivity : public brls::Activity {
public:
    explicit TitleDetailActivity(CatalogApp app);
    ~TitleDetailActivity() override;
    brls::View* createContentView() override;

private:
    CatalogApp app_;
    std::shared_ptr<std::atomic<bool>> alive_ = std::make_shared<std::atomic<bool>>(true);
};

/** Ask which storage to install to. Warns in the dialog about low battery or a firmware requirement. */
void confirmInstall(int64_t contentMetaId, const std::string& name, uint64_t size = 0,
    std::optional<uint32_t> requiredSystemVersion = std::nullopt);

} // namespace nslib
