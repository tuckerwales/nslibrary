#pragma once

#include <string>

namespace nslib {

struct Settings {
    std::string url;
    std::string token;
    /** CURLOPT_PINNEDPUBLICKEY for an HTTPS server, learned on first connect. */
    std::string tlsPin;
    std::string uuid;
    std::string name = "Switch";
    std::string defaultTarget = "sd";
    bool verifyHash = true;
    /** Zero RequiredSystemVersion on install when the console firmware is older, as DBI's reset does. */
    bool clearFirmwareRequirement = true;
    bool useUsb = false;

    void load();
    void save() const;
    void ensureUuid();
};

} // namespace nslib
