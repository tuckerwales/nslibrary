import type { AppFlag } from "@nslib/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { isLibrarySort, type LibrarySort, useApps, useRoots, useStats } from "../api";
import { ButtonLink } from "../components/Button";
import { LoadError, Loading } from "../components/Feedback";
import { inputClass } from "../components/Field";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { type TitleLayout, TitleList } from "../components/TitleList";
import { formatBytes, plural } from "../format";

const FILTERS: { flag: AppFlag | null; label: string }[] = [
  { flag: null, label: "All" },
  { flag: "no-base", label: "Missing base game" },
  { flag: "duplicate", label: "Duplicates" },
  { flag: "superseded-updates", label: "Older updates" },
  { flag: "guessed-dlc-base", label: "Unconfirmed DLC" },
  { flag: "unknown-version", label: "Unknown update version" },
  { flag: "update-available", label: "Newer update listed" },
];

const FLAG_VALUES = new Set(FILTERS.map((f) => f.flag));

const SEARCH_DEBOUNCE_MS = 200;

/**
 * The search box text, kept in step with `?q=`. Typing updates the URL after a pause; a URL
 * change from elsewhere (Back, the Library nav link) replaces the text.
 */
function useSearchDraft(q: string, setQ: (value: string, replace: boolean) => void) {
  const [draft, setDraft] = useState(q);
  const lastWritten = useRef(q);
  // Held in a ref so a new callback each render doesn't restart the debounce.
  const writeQ = useRef(setQ);
  writeQ.current = setQ;

  useEffect(() => {
    if (q === lastWritten.current) return;
    lastWritten.current = q;
    setDraft(q);
  }, [q]);

  useEffect(() => {
    if (draft === q) return;
    const timer = setTimeout(() => {
      lastWritten.current = draft;
      // Starting a search adds a history entry, so Back returns to the full library; refining
      // it doesn't add one per keystroke.
      writeQ.current(draft, q !== "");
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, q]);

  return [draft, setDraft] as const;
}

const LAYOUT_KEY = "nslib.libraryLayout";

/** List or grid, remembered in this browser. Storage can be unavailable, so it only ever helps. */
function useLibraryLayout() {
  const [layout, setLayout] = useState<TitleLayout>(() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === "grid" ? "grid" : "list";
    } catch {
      return "list";
    }
  });
  const choose = (value: TitleLayout) => {
    setLayout(value);
    try {
      localStorage.setItem(LAYOUT_KEY, value);
    } catch {
      // Not remembered; the choice still applies to this visit.
    }
  };
  return [layout, choose] as const;
}

const SORT_KEY = "nslib.librarySort";

const SORT_OPTIONS: { value: LibrarySort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "added-desc", label: "Recently added" },
  { value: "added-asc", label: "Oldest added" },
];

function readStoredSort(): LibrarySort {
  try {
    const stored = localStorage.getItem(SORT_KEY);
    return isLibrarySort(stored) ? stored : "name";
  } catch {
    return "name";
  }
}

/**
 * The order, kept in `?sort=` like the filter so Back and shared links keep it. A URL without
 * one (the Library nav link, a fresh visit) uses the order chosen last time in this browser.
 */
function useLibrarySort(
  raw: string | null,
  setParam: (value: LibrarySort | null) => void,
): [LibrarySort, (value: LibrarySort) => void] {
  const [stored, setStored] = useState(readStoredSort);
  const sort = isLibrarySort(raw) ? raw : stored;
  const choose = (value: LibrarySort) => {
    setStored(value);
    try {
      localStorage.setItem(SORT_KEY, value);
    } catch {
      // Not remembered; the URL still carries it for this visit.
    }
    setParam(value === "name" ? null : value);
  };
  return [sort, choose];
}

function SortSelect({
  sort,
  onChange,
}: {
  sort: LibrarySort;
  onChange: (value: LibrarySort) => void;
}) {
  return (
    <label className="flex shrink-0 items-center gap-2 text-sm text-muted">
      <span className="hidden sm:inline">Sort</span>
      <span className="sr-only sm:hidden">Sort by</span>
      <select
        className="h-9 rounded-md border border-line bg-panel px-2 text-sm text-ink"
        value={sort}
        onChange={(e) => {
          if (isLibrarySort(e.target.value)) onChange(e.target.value);
        }}
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const LAYOUTS: { value: TitleLayout; label: string; icon: ReactNode }[] = [
  {
    value: "list",
    label: "List",
    icon: <path d="M2 3.5h12M2 8h12M2 12.5h12" strokeLinecap="round" />,
  },
  {
    value: "grid",
    label: "Grid",
    icon: (
      <>
        <rect x="2" y="2" width="5" height="5" rx="1" />
        <rect x="9" y="2" width="5" height="5" rx="1" />
        <rect x="2" y="9" width="5" height="5" rx="1" />
        <rect x="9" y="9" width="5" height="5" rx="1" />
      </>
    ),
  },
];

function LayoutToggle({
  layout,
  onChange,
}: {
  layout: TitleLayout;
  onChange: (value: TitleLayout) => void;
}) {
  return (
    <fieldset className="flex shrink-0 rounded-md border border-line p-0.5">
      <legend className="sr-only">View as</legend>
      {LAYOUTS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={layout === option.value}
          onClick={() => onChange(option.value)}
          className={`inline-flex h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-sm ${
            layout === option.value
              ? "bg-ink font-semibold text-panel"
              : "text-muted hover:text-ink"
          }`}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            {option.icon}
          </svg>
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const rawFlag = params.get("flag") as AppFlag | null;
  const flag = FLAG_VALUES.has(rawFlag) ? rawFlag : null;

  const [draft, setDraft] = useSearchDraft(q, (value, replace) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set("q", value);
        else next.delete("q");
        return next;
      },
      { replace },
    ),
  );

  const [layout, setLayout] = useLibraryLayout();
  const [sort, setSort] = useLibrarySort(params.get("sort"), (value) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set("sort", value);
      else next.delete("sort");
      return next;
    }),
  );
  const apps = useApps(q, flag, sort);
  const byDate = sort !== "name";
  const stats = useStats().data;
  const roots = useRoots().data;

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

      {stats && !stats.keysConfigured && (
        <p className="mb-6 max-w-[65ch] border-l-2 border-dlc pl-3">
          Add your console's <span className="semi-condensed">prod.keys</span> in{" "}
          <Link to="/settings" className="text-accent hover:underline">
            Settings
          </Link>{" "}
          to show official names, icons, and firmware info. Keys stay on this computer.
        </p>
      )}

      <div className="flex flex-col gap-3">
        <label className="sr-only" htmlFor="library-search">
          Search the library
        </label>
        <div className="flex items-center gap-3">
          <input
            id="library-search"
            type="search"
            placeholder="Search by name or title ID"
            className={`${inputClass} min-w-0 max-w-md`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="ml-auto flex items-center gap-3">
            <SortSelect sort={sort} onChange={setSort} />
            <LayoutToggle layout={layout} onChange={setLayout} />
          </div>
        </div>
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
        ) : !apps.data ? (
          <Loading />
        ) : apps.data.length > 0 ? (
          <TitleList
            key={`${q}\n${flag}\n${sort}`}
            items={apps.data.map((app) => ({
              app,
              ...(byDate && {
                detail: (
                  <>
                    Added <RelativeTime timestamp={app.addedAt} />
                  </>
                ),
              }),
            }))}
            layout={layout}
          />
        ) : q || flag ? (
          <p className="text-muted">No games match this search.</p>
        ) : roots && roots.length === 0 ? (
          <div className="max-w-md">
            <h2 className="text-xl">Add a folder to get started</h2>
            <p className="mt-2 text-muted">
              Point NSLibrary at the folders that hold your NSP, NSZ, XCI, and XCZ files.
            </p>
            <ButtonLink to="/folders" className="mt-4">
              Add a folder
            </ButtonLink>
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
