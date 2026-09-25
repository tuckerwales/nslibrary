import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import { useAuthStatus } from "./api";
import { Button } from "./components/Button";
import { Loading } from "./components/Feedback";
import { Shell } from "./components/Shell";
import { useLiveUpdates } from "./live";
import { LoginPage, SetupPage } from "./pages/AuthPages";

const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((module) => ({ default: module[name] })));

const AppPage = page(() => import("./pages/AppPage"), "AppPage");
const DevicesPage = page(() => import("./pages/DevicesPage"), "DevicesPage");
const FoldersPage = page(() => import("./pages/FoldersPage"), "FoldersPage");
const HistoryPage = page(() => import("./pages/HistoryPage"), "HistoryPage");
const HomebrewPage = page(() => import("./pages/HomebrewPage"), "HomebrewPage");
const LibraryPage = page(() => import("./pages/LibraryPage"), "LibraryPage");
const NotFoundPage = page(() => import("./pages/NotFoundPage"), "NotFoundPage");
const ProblemsPage = page(() => import("./pages/ProblemsPage"), "ProblemsPage");
const SavesPage = page(() => import("./pages/SavesPage"), "SavesPage");
const SettingsPage = page(() => import("./pages/SettingsPage"), "SettingsPage");
const SwitchLibraryPage = page(() => import("./pages/SwitchLibraryPage"), "SwitchLibraryPage");

export function App() {
  const auth = useAuthStatus();
  useLiveUpdates(auth.data?.authenticated === true);

  if (auth.isPending) return <Loading className="grid min-h-dvh place-items-center" />;

  // A failed background refetch keeps the last known status rather than hiding the app.
  if (!auth.data) {
    return (
      <div className="grid min-h-dvh place-items-center px-4">
        <div className="max-w-sm">
          <h1 className="text-xl">Can't reach the server</h1>
          <p className="mt-2 text-muted">Check that NSLibrary is running, then try again.</p>
          <Button className="mt-5" onClick={() => void auth.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (auth.data.setupRequired) return <SetupPage tokenRequired={auth.data.setupTokenRequired} />;
  if (!auth.data.authenticated) return <LoginPage />;

  return (
    <Shell username={auth.data.username ?? ""}>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/apps/:applicationId" element={<AppPage />} />
          <Route path="/homebrew" element={<HomebrewPage />} />
          <Route path="/switch" element={<SwitchLibraryPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/saves" element={<SavesPage />} />
          <Route path="/problems" element={<ProblemsPage />} />
          <Route path="/devices" element={<DevicesPage />} />
          <Route path="/folders" element={<FoldersPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
