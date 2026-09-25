import { type ReactNode, useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router";
import { isCompressActive, useCompressTasks, useLogout, useStats } from "../api";
import { Button } from "./Button";
import { ConnectionBanner } from "./ConnectionBanner";
import { Toaster } from "./Toaster";

function NavItem({
  to,
  label,
  count,
  alert,
}: {
  to: string;
  label: string;
  count?: number;
  alert?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `flex h-9 shrink-0 items-center justify-between gap-4 rounded-md px-3 text-base ${
          isActive ? "bg-ground font-semibold text-ink" : "text-muted hover:text-ink"
        }`
      }
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className={`text-sm ${alert ? "font-semibold text-danger" : "text-muted"}`}>
          {count.toLocaleString()}
        </span>
      )}
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

export function Shell({ username, children }: { username: string; children: ReactNode }) {
  const stats = useStats().data;
  // Loaded here so compressions show in the nav, and finish with a message, on every page.
  const compressing = (useCompressTasks().data ?? []).filter(isCompressActive).length;
  const logout = useLogout();
  const main = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useFocusOnNavigate(main);

  // On narrow screens the nav scrolls sideways; keep the current page's item in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the path changes
  useEffect(() => {
    nav.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[224px_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-accent px-4 py-2 font-semibold text-accent-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <aside className="border-b border-line bg-panel md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:border-r md:border-b-0">
        <div className="flex items-center justify-between px-4 pt-3 md:px-5 md:pt-6">
          <span className="text-xl font-bold condensed md:text-2xl">NSLibrary</span>
          <Button variant="ghost" className="px-2 md:hidden" onClick={() => logout.mutate()}>
            Sign out
          </Button>
        </div>
        <nav
          ref={nav}
          aria-label="Main"
          className="nav-scroll flex gap-1 overflow-x-auto px-2 py-2 md:mt-6 md:flex-1 md:flex-col md:px-3"
        >
          <NavItem to="/" label="Library" count={stats?.applications} />
          <NavItem to="/switch" label="On this Switch" />
          <NavItem to="/history" label="History" />
          <NavItem to="/saves" label="Saves" />
          <NavItem to="/homebrew" label="Homebrew" count={stats?.homebrew} />
          <NavItem to="/problems" label="Problems" count={stats?.problems} alert />
          <NavItem to="/compression" label="Compression" count={compressing} />
          <NavItem to="/devices" label="Devices" />
          <NavItem to="/folders" label="Folders" />
          <NavItem to="/settings" label="Settings" />
        </nav>
        <div className="hidden border-t border-line px-5 py-4 md:block">
          <p className="truncate text-sm text-muted">Signed in as {username}</p>
          <Button variant="ghost" className="-ml-4 mt-1" onClick={() => logout.mutate()}>
            Sign out
          </Button>
        </div>
      </aside>
      <main
        id="main"
        ref={main}
        tabIndex={-1}
        className="min-w-0 px-4 py-6 outline-none md:px-10 md:py-10"
      >
        <ConnectionBanner />
        {children}
      </main>
      <Toaster />
    </div>
  );
}
