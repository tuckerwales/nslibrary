#pragma once

namespace nslib {

/** M5 implements NCZ/NSZ. M4 rejects those containers before this is called. */
inline const char* nczUnsupportedMessage() {
    return "NSZ/NCZ installs need the full engine (milestone 5)";
}

} // namespace nslib
