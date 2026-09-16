#pragma once

#include <string>

namespace nslib {

struct Settings {
    std::string url;
    std::string token;
    std::string uuid;
    std::string name = "Switch";
    std::string defaultTarget = "sd";
    bool verifyHash = true;
    bool useUsb = false;

    void load();
    void save() const;
    void ensureUuid();
};

} // namespace nslib
