import { Route, Routes } from "react-router";
import { useAuthStatus } from "./api";
import { Button } from "./components/Button";
import { Shell } from "./components/Shell";
import { useLiveUpdates } from "./live";
import { AppPage } from "./pages/AppPage";
import { LoginPage, SetupPage } from "./pages/AuthPages";
import { FoldersPage } from "./pages/FoldersPage";
import { HomebrewPage } from "./pages/HomebrewPage";
import { LibraryPage } from "./pages/LibraryPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProblemsPage } from "./pages/ProblemsPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  const auth = useAuthStatus();
  useLiveUpdates(auth.data?.authenticated === true);

  if (auth.isPending) return null;

  if (auth.isError) {
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

  if (auth.data.setupRequired) return <SetupPage />;
  if (!auth.data.authenticated) return <LoginPage />;

  return (
    <Shell username={auth.data.username ?? ""}>
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/apps/:applicationId" element={<AppPage />} />
        <Route path="/homebrew" element={<HomebrewPage />} />
        <Route path="/problems" element={<ProblemsPage />} />
        <Route path="/folders" element={<FoldersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Shell>
  );
}
