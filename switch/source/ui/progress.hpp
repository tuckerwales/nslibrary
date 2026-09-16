#pragma once

#include <string>

namespace nslib {

void showProgress(const std::string& title);
void updateProgress(const std::string& line);
void hideProgress();

} // namespace nslib
