#pragma once

#include <borealis.hpp>

namespace nslib {

class ConnectActivity : public brls::Activity {
public:
    brls::View* createContentView() override;
};

} // namespace nslib
