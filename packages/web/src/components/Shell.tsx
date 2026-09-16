import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { useLogout, useStats } from "../api";
import { Button } from "./Button";

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

export function Shell({ username, children }: { username: string; children: ReactNode }) {
  const stats = useStats().data;
  const logout = useLogout();

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[224px_minmax(0,1fr)]">
      <aside className="border-b border-line bg-panel md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:border-r md:border-b-0">
        <div className="flex items-center justify-between px-4 pt-3 md:px-5 md:pt-6">
          <span className="text-xl font-bold condensed md:text-2xl">NSLibrary</span>
          <Button variant="ghost" className="px-2 md:hidden" onClick={() => logout.mutate()}>
            Sign out
          </Button>
        </div>
        <nav
          aria-label="Main"
          className="flex gap-1 overflow-x-auto px-2 py-2 md:mt-6 md:flex-1 md:flex-col md:px-3"
        >
          <NavItem to="/" label="Library" count={stats?.applications} />
          <NavItem to="/homebrew" label="Homebrew" count={stats?.homebrew} />
          <NavItem to="/problems" label="Problems" count={stats?.problems} alert />
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
      <main className="min-w-0 px-4 py-6 md:px-10 md:py-10">{children}</main>
    </div>
  );
}
