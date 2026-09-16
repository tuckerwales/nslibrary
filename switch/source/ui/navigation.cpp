#include "ui/main_activity.hpp"

#include "app/session.hpp"
#include "ui/connect.hpp"
#include "ui/pair.hpp"

#include <borealis.hpp>

using namespace brls::literals;

namespace nslib {
namespace {

bool isScreen(brls::Activity* activity, Screen screen) {
    switch (screen) {
        case Screen::Connect: return dynamic_cast<ConnectActivity*>(activity) != nullptr;
        case Screen::Pair: return dynamic_cast<PairActivity*>(activity) != nullptr;
        case Screen::Main: return dynamic_cast<MainActivity*>(activity) != nullptr;
    }
    return false;
}

brls::Activity* makeScreen(Screen screen) {
    switch (screen) {
        case Screen::Connect: return new ConnectActivity();
        case Screen::Pair: return new PairActivity();
        case Screen::Main: return new MainActivity();
    }
    return nullptr;
}

void popToRoot(const std::function<void()>& then) {
    if (brls::Application::getActivitiesStack().size() <= 1) {
        then();
        return;
    }
    brls::Application::popActivity(brls::TransitionAnimation::NONE, [then] {
        // The popped activity is freed after this callback returns; continue on the next frame.
        brls::sync([then] { popToRoot(then); });
    });
}

bool isInside(brls::View* view, brls::View* container) {
    for (brls::View* v = view; v; v = v->hasParent() ? v->getParent() : nullptr) {
        if (v == container) return true;
    }
    return false;
}

brls::View* firstFocusable(brls::View* view) {
    if (!view) return nullptr;
    if (view->isFocusable()) return view;
    if (auto* box = dynamic_cast<brls::Box*>(view)) {
        for (auto* child : box->getChildren()) {
            if (auto* found = firstFocusable(child)) return found;
        }
    }
    return nullptr;
}

template <typename T>
bool rebuildIn(brls::Activity* activity, const char* id) {
    if (auto* tab = dynamic_cast<T*>(activity->getView(id))) {
        tab->rebuild();
        return true;
    }
    return false;
}

void startSession() {
    brls::Logger::info("session start on main");
    auto& session = Session::instance();
    try {
        session.start();
        try {
            session.refreshInstalled();
        } catch (const std::exception& e) {
            brls::Logger::error("refreshInstalled: {}", e.what());
        } catch (...) {
            brls::Logger::error("refreshInstalled: unknown");
        }
        refreshVisibleTabs();
        brls::Logger::info("library tab ready");
    } catch (const ApiError& e) {
        const std::string code = e.code;
        const std::string msg = e.what();
        brls::Logger::error("session ApiError {} {}", code, msg);
        session.setStatus(msg);
        refreshVisibleTabs();
        if (code == "UNAUTHORIZED" || code == "DEVICE_REVOKED") {
            session.forgetDevice();
            showScreen(Screen::Pair, [msg] { showError(msg); });
            return;
        }
        auto* dialog = new brls::Dialog(msg);
        dialog->addButton("hints/ok"_i18n, []() {});
        dialog->addButton("app/connect/change"_i18n, []() { showScreen(Screen::Connect); });
        dialog->open();
    } catch (const std::exception& e) {
        const std::string msg = e.what();
        brls::Logger::error("session error {}", msg);
        session.setStatus(msg);
        refreshVisibleTabs();
        auto* dialog = new brls::Dialog(msg);
        dialog->addButton("hints/ok"_i18n, []() {});
        dialog->addButton("app/connect/change"_i18n, []() { showScreen(Screen::Connect); });
        dialog->open();
    } catch (...) {
        brls::Logger::error("session error unknown");
        session.setStatus("Connection failed");
        refreshVisibleTabs();
        showError("Connection failed");
    }
}

} // namespace

void showScreen(Screen screen, std::function<void()> then) {
    popToRoot([screen, then] {
        const auto stack = brls::Application::getActivitiesStack();
        if (stack.empty() || !isScreen(stack.front(), screen)) {
            brls::Application::pushActivity(makeScreen(screen));
        }
        if (then) then();
    });
}

void replaceChildren(brls::Box* list, const std::function<void(brls::Box*)>& build,
    const std::function<brls::View*()>& focusTarget)
{
    if (!list) return;
    const std::vector<brls::View*> old = list->getChildren();
    bool focusWasInside = false;
    brls::View* focus = brls::Application::getCurrentFocus();
    for (auto* child : old) {
        if (isInside(focus, child)) focusWasInside = true;
    }

    build(list);

    if (focusWasInside) {
        brls::View* target = focusTarget ? focusTarget() : nullptr;
        if (!target) {
            const auto& now = list->getChildren();
            for (size_t i = old.size(); i < now.size() && !target; i++) target = firstFocusable(now[i]);
        }
        if (!target) {
            if (auto* activity = list->getParentActivity()) target = activity->getContentView();
        }
        brls::Application::giveFocus(target);
    }
    for (auto* child : old) list->removeView(child);
}

void showError(const std::string& message) {
    auto* dialog = new brls::Dialog(message);
    dialog->addButton("hints/ok"_i18n, []() {});
    dialog->open();
}

void enterPairedSession() {
    auto& session = Session::instance();
    brls::Logger::info("enterPairedSession ready={}", session.isReady());
    if (!session.isReady()) session.setStatus("app/connect/connecting"_i18n);
    showScreen(Screen::Main, [] {
        brls::Logger::info("MainActivity shown");
        if (Session::instance().isReady()) {
            refreshVisibleTabs();
            return;
        }
        // libcurl on Switch is not safe off the main thread. Pairing already used curl here;
        // hello/catalog/events stay on this thread too. Start after the activity has drawn once.
        brls::sync([] { startSession(); });
    });
}

void refreshVisibleTabs() {
    for (auto* activity : brls::Application::getActivitiesStack()) {
        if (!dynamic_cast<MainActivity*>(activity)) continue;
        if (rebuildIn<LibraryTab>(activity, "library")) continue;
        if (rebuildIn<QueueTab>(activity, "queue")) continue;
        if (rebuildIn<UpdatesTab>(activity, "updates")) continue;
        if (rebuildIn<InstalledTab>(activity, "installed")) continue;
        rebuildIn<MissingTab>(activity, "missing");
    }
}

} // namespace nslib
