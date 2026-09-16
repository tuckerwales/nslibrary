#pragma once

#include <cstdint>
#include <functional>
#include <string>

namespace nslib {

/** `onCancel` runs when B is pressed. Empty cancels the running install job. */
void showProgress(const std::string& title, std::function<void()> onCancel = {});
void updateProgress(const std::string& line, uint64_t done = 0, uint64_t total = 0);
/** Persistent line under the progress bar (low battery, firmware too old). Cleared by hideProgress. */
void setProgressWarning(const std::string& text);
void hideProgress();
bool progressVisible();

/**
 * Draw a frame and keep the applet alive while curl_easy_perform is blocked.
 * `runTick` false skips the progress tick: callers already inside a request must not start another one on
 * the same transport (its mutex is held, so the tick would deadlock the UI thread).
 */
void pumpProgressUi(bool force = false, bool runTick = true);

/** Runs on the UI thread from pumpProgressUi about every two seconds while the overlay is up.
 *  Sync tasks do not run during a blocking install, so this is where side-channel work goes. */
void setProgressTick(std::function<void()> fn);

} // namespace nslib
