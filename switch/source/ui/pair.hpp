#pragma once

#include <borealis.hpp>

namespace nslib {

class PairActivity : public brls::Activity {
public:
    brls::View* createContentView() override;
};

} // namespace nslib
