import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { isCompressActive, useCompressTasks, useLogout, useStats } from "../api";
import { Count } from "./Badge";
import { ConnectionBanner } from "./ConnectionBanner";
import { Icon, type IconName } from "./Icon";
import { Logo } from "./Logo";
import { ThemePicker } from "./ThemePicker";
import { Toaster } from "./Toaster";

interface NavEntry {
  to: string;
  label: string;
  /** A shorter label for the phone tab bar. */
  short?: string;
  icon: IconName;
  count?: number;
  alert?: boolean;
  /** Read after the count by screen readers, like "problems". */
  noun?: string;
}

function NavItem({ entry, onNavigate }: { entry: NavEntry; onNavigate?: () => void }) {
  return (
    <NavLink
      to={entry.to}
      end={entry.to === "/"}
      onClick={onNavigate}
      className={({ isActive }) =>
        `flex h-9 shrink-0 items-center gap-3 rounded-md px-3 text-base transition-colors ${
          isActive
            ? "bg-ground font-semibold text-ink"
            : "text-muted hover:bg-ground/60 hover:text-ink"
        }`
      }
    >
      <Icon name={entry.icon} />
      <span className="flex-1">{entry.label}</span>
      {entry.count !== undefined && entry.count > 0 && (
        <Count
          value={entry.count}
          alert={entry.alert}
          label={entry.noun && `${entry.count.toLocaleString()} ${entry.noun}`}
        />
      )}
    </NavLink>
  );
}

/** A tab in the phone tab bar: an icon over a short label, with a dot for counts that need attention. */
function TabItem({ entry }: { entry: NavEntry }) {
  return (
    <NavLink
      to={entry.to}
      end={entry.to === "/"}
      className={({ isActive }) =>
        `relative flex flex-col items-center justify-center gap-0.5 text-xs ${
          isActive ? "font-semibold text-accent" : "text-muted"
        }`
      }
    >
      <span className="relative">
        <Icon name={entry.icon} size={22} />
        {entry.alert && entry.count !== undefined && entry.count > 0 && (
          <span className="absolute -top-1.5 -right-2.5">
            <Count value={entry.count} alert label={`${entry.count} ${entry.noun ?? ""}`} />
          </span>
        )}
      </span>
      {entry.short ?? entry.label}
    </NavLink>
  );
}

/** After in-app navigation, move focus to the new page's heading so it gets announced. */
function useFocusOnNavigate(main: React.RefObject<HTMLElement | null>) {
  const { pathname } = useLocation();
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the path changes
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const target = main.current?.querySelector<HTMLElement>("h1") ?? main.current;
    target?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [pathname, main]);
}

/** The phone's "More" sheet: the pages without a tab, the theme, and signing out. */
function MoreSheet({
  entries,
  username,
  onClose,
  onSignOut,
}: {
  entries: NavEntry[];
  username: string;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        tabIndex={-1}
        className="fixed inset-0 z-30 bg-ink/30 md:hidden"
        onClick={onClose}
      />
      <div
        ref={sheet}
        id="more-sheet"
        className="fixed inset-x-2 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-40 rounded-lg border border-line bg-panel p-2 shadow-lg md:hidden"
      >
        <nav aria-label="More" className="flex flex-col gap-0.5">
          {entries.map((entry) => (
            <NavItem key={entry.to} entry={entry} onNavigate={onClose} />
          ))}
        </nav>
        <div className="mt-2 flex items-center gap-3 border-t border-line px-3 pt-3 pb-1">
          <p className="min-w-0 flex-1 truncate text-sm text-muted">Signed in as {username}</p>
          <div className="w-28">
            <ThemePicker />
          </div>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="mt-1 flex h-9 w-full items-center gap-3 rounded-md px-3 text-muted hover:text-ink"
        >
          <Icon name="signout" />
          Sign out
        </button>
      </div>
    </>
  );
}

export function Shell({ username, children }: { username: string; children: ReactNode }) {
  const stats = useStats().data;
  // Loaded here so compressions show in the nav, and finish with a message, on every page.
  const compressing = (useCompressTasks().data ?? []).filter(isCompressActive).length;
  const logout = useLogout();
  const main = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  useFocusOnNavigate(main);

  // biome-ignore lint/correctness/useExhaustiveDependencies: closes when the path changes
  useEffect(() => setMoreOpen(false), [pathname]);

  const library: NavEntry = {
    to: "/",
    label: "Library",
    icon: "library",
    count: stats?.applications,
    noun: "games",
  };
  const onSwitch: NavEntry = {
    to: "/switch",
    label: "On this Switch",
    short: "Switch",
    icon: "console",
  };
  const history: NavEntry = { to: "/history", label: "History", icon: "history" };
  const problems: NavEntry = {
    to: "/problems",
    label: "Problems",
    icon: "problems",
    count: stats?.problems,
    alert: true,
    noun: "problems",
  };
  const homebrew: NavEntry = {
    to: "/homebrew",
    label: "Homebrew",
    icon: "homebrew",
    count: stats?.homebrew,
  };
  const compression: NavEntry = {
    to: "/compression",
    label: "Compression",
    icon: "compress",
    count: compressing,
    noun: "compressing",
  };
  const devices: NavEntry = { to: "/devices", label: "Devices", icon: "devices" };
  const folders: NavEntry = { to: "/folders", label: "Folders", icon: "folder" };
  const settings: NavEntry = { to: "/settings", label: "Settings", icon: "settings" };

  const all = [
    library,
    onSwitch,
    history,
    homebrew,
    problems,
    compression,
    devices,
    folders,
    settings,
  ];
  const tabs = [library, onSwitch, history, problems];
  const more = all.filter((entry) => !tabs.includes(entry));
  const onMorePage = more.some((entry) => pathname.startsWith(entry.to));

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[232px_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-accent px-4 py-2 font-semibold text-accent-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      {/* Wide screens: a sidebar with every page. */}
      <aside className="hidden border-r border-line bg-panel md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
        <div className="flex items-center gap-2 px-5 pt-6">
          <Logo />
          <span className="text-2xl font-bold condensed">NSLibrary</span>
        </div>
        <nav aria-label="Main" className="mt-6 flex flex-1 flex-col gap-0.5 overflow-y-auto px-3">
          {all.map((entry) => (
            <NavItem key={entry.to} entry={entry} />
          ))}
        </nav>
        <div className="space-y-3 border-t border-line px-5 py-4">
          <ThemePicker />
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm text-muted">Signed in as {username}</p>
            <button
              type="button"
              className="-mr-1.5 inline-flex shrink-0 items-center gap-1.5 rounded px-1.5 py-1 text-sm font-semibold text-muted hover:text-ink"
              onClick={() => logout.mutate()}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* Phones: a top bar with the name, and tabs along the bottom. */}
      <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-line bg-panel/95 px-4 backdrop-blur md:hidden">
        <Logo size={24} />
        <span className="text-xl font-bold condensed">NSLibrary</span>
      </header>

      <main
        id="main"
        ref={main}
        tabIndex={-1}
        className="min-w-0 px-4 pt-6 pb-[calc(6rem+env(safe-area-inset-bottom))] outline-none md:px-10 md:py-10"
      >
        <div className="mx-auto max-w-6xl">
          <ConnectionBanner />
          {children}
        </div>
      </main>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 grid h-[calc(4rem+env(safe-area-inset-bottom))] grid-cols-5 border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {tabs.map((entry) => (
          <TabItem key={entry.to} entry={entry} />
        ))}
        <button
          type="button"
          aria-expanded={moreOpen}
          aria-controls="more-sheet"
          onClick={() => setMoreOpen((open) => !open)}
          className={`flex flex-col items-center justify-center gap-0.5 text-xs ${
            moreOpen || onMorePage ? "font-semibold text-accent" : "text-muted"
          }`}
        >
          <Icon name="more" size={22} />
          More
        </button>
      </nav>
      {moreOpen && (
        <MoreSheet
          entries={more}
          username={username}
          onClose={closeMore}
          onSignOut={() => logout.mutate()}
        />
      )}

      <Toaster />
    </div>
  );
}
