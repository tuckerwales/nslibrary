#include "ui/progress.hpp"

#include <borealis.hpp>

namespace nslib {

void showProgress(const std::string& title) {
    brls::sync([title] { brls::Application::notify(title); });
}

void updateProgress(const std::string& line) {
    brls::Logger::info("{}", line);
}

void hideProgress() {}

} // namespace nslib
