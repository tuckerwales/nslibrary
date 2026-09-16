#include "api/poller.hpp"

#include <chrono>

namespace nslib {

EventPoller::EventPoller(DeviceApiClient& client, Handler handler)
    : client_(client), handler_(std::move(handler)) {}

EventPoller::~EventPoller() { stop(); }

void EventPoller::start() {
    if (running_.exchange(true)) return;
    thread_ = std::thread([this] { loop(); });
}

void EventPoller::stop() {
    running_ = false;
    if (thread_.joinable()) thread_.detach();
}

void EventPoller::loop() {
    while (running_) {
        try {
            auto page = client_.events(cursor_, 25);
            cursor_ = page.cursor;
            for (const auto& ev : page.ev) {
                if (!running_) break;
                if (handler_) handler_(ev);
            }
        } catch (...) {
            if (!running_) break;
            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
    }
}

} // namespace nslib
