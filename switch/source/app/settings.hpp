#pragma once

#include <string>

namespace nslib {

struct Settings {
    std::string url;
    std::string token;
    std::string uuid;
    std::string name = "Switch";

    void load();
    void save() const;
    void ensureUuid();
};

} // namespace nslib
