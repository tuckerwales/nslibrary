import type { AppFlag } from "@nslib/shared";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useApps, useRoots, useStats } from "../api";
import { ContentStrip } from "../components/ContentStrip";
import { inputClass } from "../components/Field";
import { LoadError, PageHeader } from "../components/PageHeader";
import { TitleIcon } from "../components/TitleIcon";
import { formatBytes, plural } from "../format";

const FILTERS: { flag: AppFlag | null; label: string }[] = [
  { flag: null, label: "All" },
  { flag: "no-base", label: "Missing base game" },
  { flag: "duplicate", label: "Duplicates" },
  { flag: "superseded-updates", label: "Older updates" },
  { flag: "guessed-dlc-base", label: "Unconfirmed DLC" },
  { flag: "unknown-version", label: "Unknown update version" },
];

const FLAG_VALUES = new Set(FILTERS.map((f) => f.flag));

export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const rawFlag = params.get("flag") as AppFlag | null;
  const flag = FLAG_VALUES.has(rawFlag) ? rawFlag : null;
  const [draft, setDraft] = useState(q);

  const apps = useApps(q, flag);
  const stats = useStats().data;
  const roots = useRoots().data;

  useEffect(() => {
    if (draft === q) return;
    const timer = setTimeout(() => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (draft) next.set("q", draft);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [draft, q, setParams]);

  const setFlag = (value: AppFlag | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set("flag", value);
      else next.delete("flag");
      return next;
    });

  const scanning = roots?.some((root) => root.scan.state !== "idle");

  return (
    <>
      <PageHeader title="Library">
        {stats && stats.applications > 0 && (
          <p>
            {plural(stats.applications, "game")} in {plural(stats.files, "file")},{" "}
            {formatBytes(stats.totalSize)}
          </p>
        )}
      </PageHeader>

      <div className="flex flex-col gap-3">
        <label className="sr-only" htmlFor="library-search">
          Search the library
        </label>
        <input
          id="library-search"
          type="search"
          placeholder="Search by name or title ID"
          className={`${inputClass} max-w-md`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <fieldset className="flex flex-wrap gap-1.5">
          <legend className="sr-only">Filter</legend>
          {FILTERS.map((filter) => (
            <button
              key={filter.label}
              type="button"
              aria-pressed={flag === filter.flag}
              onClick={() => setFlag(filter.flag)}
              className={`h-8 rounded-full px-3 text-sm ${
                flag === filter.flag
                  ? "bg-ink font-semibold text-panel"
                  : "border border-line text-muted hover:text-ink"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </fieldset>
      </div>

      <div className="mt-6">
        {apps.error ? (
          <LoadError error={apps.error} />
        ) : !apps.data ? null : apps.data.length > 0 ? (
          <ul className="border-t border-line">
            {apps.data.map((app) => (
              <li key={app.applicationId} className="border-b border-line">
                <Link
                  to={`/apps/${app.applicationId}`}
                  className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 px-2 py-3 hover:bg-panel md:grid-cols-[44px_minmax(0,1fr)_auto_5.5rem]"
                >
                  <span className="row-span-2 md:row-span-1">
                    <TitleIcon name={app.name} seed={app.applicationId} url={app.iconUrl} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-lg font-semibold semi-condensed">
                      {app.name}
                    </span>
                    <span className="block text-sm text-muted">{app.applicationId}</span>
                  </span>
                  <ContentStrip app={app} />
                  <span className="hidden text-right text-sm text-muted md:block">
                    {formatBytes(app.totalSize)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : q || flag ? (
          <p className="text-muted">No games match this search.</p>
        ) : roots && roots.length === 0 ? (
          <div className="max-w-md">
            <h2 className="text-xl">Add a folder to get started</h2>
            <p className="mt-2 text-muted">
              Point NSLibrary at the folders that hold your NSP, NSZ, XCI, and XCZ files.
            </p>
            <Link
              to="/folders"
              className="mt-4 inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink"
            >
              Add a folder
            </Link>
          </div>
        ) : (
          <p className="text-muted">
            {scanning ? "Scanning your folders…" : "No games found in your folders yet."}
          </p>
        )}
      </div>
    </>
  );
}
