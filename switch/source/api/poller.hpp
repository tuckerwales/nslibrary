#pragma once

#include "api/client.hpp"

#include <atomic>
#include <functional>
#include <string>
#include <thread>

namespace nslib {

class EventPoller {
public:
    using Handler = std::function<void(const DeviceEvent&)>;

    EventPoller(DeviceApiClient& client, Handler handler, int waitSeconds = 25);
    ~EventPoller();

    EventPoller(const EventPoller&) = delete;
    EventPoller& operator=(const EventPoller&) = delete;

    void start();
    void stop();

private:
    DeviceApiClient& client_;
    Handler handler_;
    std::atomic<bool> running_{false};
    std::thread thread_;
    std::string cursor_;
    int waitSeconds_ = 25;

    void loop();
};

} // namespace nslib
