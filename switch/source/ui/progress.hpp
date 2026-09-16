#pragma once

#include <cstdint>
#include <string>

namespace nslib {

void showProgress(const std::string& title);
void updateProgress(const std::string& line, uint64_t done = 0, uint64_t total = 0);
void hideProgress();

/** Draw a frame and keep the applet alive while curl_easy_perform is blocked. */
void pumpProgressUi(bool force = false);

} // namespace nslib
