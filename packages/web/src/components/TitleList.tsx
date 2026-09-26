import type { AppSummary } from "@nslib/shared";
import { type ReactNode, useState } from "react";
import { Link, useLocation } from "react-router";
import { formatBytes } from "../format";
import { Button } from "./Button";
import { ContentStrip } from "./ContentStrip";
import { TitleIcon } from "./TitleIcon";

/** Rows rendered at a time; large libraries grow on request instead of all at once. */
export const TITLE_PAGE_SIZE = 100;

export interface TitleListItem {
  app: AppSummary;
  /** Shown under the name instead of the title ID. */
  detail?: ReactNode;
}

/** Ticking titles instead of opening them, for acting on several at once. */
export interface TitleSelection {
  selected: ReadonlySet<string>;
  onToggle: (applicationId: string) => void;
}

/** Where a title page's back link goes: the list it was opened from, search and all. */
export interface BackState {
  back: string;
}

type RowProps = TitleListItem & { back: BackState; selection?: TitleSelection };

/** A link to the title's page, or while selecting, a label that ticks it. */
function RowTarget({
  app,
  back,
  selection,
  className,
  children,
}: {
  app: AppSummary;
  back: BackState;
  selection?: TitleSelection;
  className: string;
  children: ReactNode;
}) {
  if (selection) {
    const checked = selection.selected.has(app.applicationId);
    return (
      <label className={`${className} cursor-pointer ${checked ? "bg-accent/10" : ""}`}>
        {children}
        <input
          type="checkbox"
          className="sr-only"
          checked={checked}
          onChange={() => selection.onToggle(app.applicationId)}
          aria-label={`Select ${app.name}`}
        />
      </label>
    );
  }
  return (
    <Link to={`/apps/${app.applicationId}`} state={back} className={className}>
      {children}
    </Link>
  );
}

/** The tick shown on a title while selecting; the real checkbox is visually hidden beside it. */
function Tick({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid size-5 shrink-0 place-items-center rounded border text-xs font-bold ${
        checked ? "border-accent bg-accent text-accent-ink" : "border-muted bg-panel"
      }`}
    >
      {checked ? "✓" : ""}
    </span>
  );
}

function TitleRow({ app, detail, back, selection }: RowProps) {
  const checked = selection?.selected.has(app.applicationId) ?? false;
  return (
    <li className="border-b border-line">
      <RowTarget
        app={app}
        back={back}
        selection={selection}
        className={`grid items-center gap-x-4 gap-y-1.5 rounded-md px-2 py-3 transition-colors hover:bg-panel has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
          selection
            ? "grid-cols-[20px_44px_minmax(0,1fr)] md:grid-cols-[20px_44px_minmax(0,1fr)_auto_5.5rem]"
            : "grid-cols-[44px_minmax(0,1fr)] md:grid-cols-[44px_minmax(0,1fr)_auto_5.5rem]"
        }`}
      >
        {selection && (
          <span className="row-span-2 md:row-span-1">
            <Tick checked={checked} />
          </span>
        )}
        <span className="row-span-2 md:row-span-1">
          <TitleIcon name={app.name} seed={app.applicationId} url={app.iconUrl} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-lg font-semibold semi-condensed">{app.name}</span>
          <span className="block text-sm text-muted">{detail ?? app.applicationId}</span>
        </span>
        <ContentStrip app={app} />
        <span className="hidden text-right text-sm text-muted md:block">
          {formatBytes(app.totalSize)}
        </span>
      </RowTarget>
    </li>
  );
}

export type TitleLayout = "list" | "grid";

/** A cover-art card, like the Switch app's library grid. */
function TitleCard({ app, detail, back, selection }: RowProps) {
  const checked = selection?.selected.has(app.applicationId) ?? false;
  return (
    <li>
      <RowTarget
        app={app}
        back={back}
        selection={selection}
        className="group relative flex h-full flex-col gap-2 rounded-lg p-2 transition-colors hover:bg-panel has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
      >
        <span className="block rounded-md shadow-card transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:shadow-md">
          <TitleIcon name={app.name} seed={app.applicationId} url={app.iconUrl} size="fill" />
        </span>
        {selection && (
          <span className="absolute top-3.5 left-3.5">
            <Tick checked={checked} />
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate font-semibold semi-condensed" title={app.name}>
            {app.name}
          </span>
          <span className="block truncate text-sm text-muted">
            {detail ?? formatBytes(app.totalSize)}
          </span>
        </span>
        <ContentStrip app={app} />
      </RowTarget>
    </li>
  );
}

/**
 * A list of titles linking to their pages, as rows or a grid of cards. Give it a `key` that
 * changes with the search so the visible count starts over.
 */
export function TitleList({
  items,
  layout = "list",
  selection,
}: {
  items: TitleListItem[];
  layout?: TitleLayout;
  selection?: TitleSelection;
}) {
  const [visible, setVisible] = useState(TITLE_PAGE_SIZE);
  const location = useLocation();
  const back: BackState = { back: location.pathname + location.search };
  const shown = items.slice(0, visible);
  const remaining = items.length - shown.length;

  return (
    <>
      {layout === "grid" ? (
        <ul className="-mx-2 grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-y-2">
          {shown.map((item) => (
            <TitleCard key={item.app.applicationId} {...item} back={back} selection={selection} />
          ))}
        </ul>
      ) : (
        <ul className="border-t border-line">
          {shown.map((item) => (
            <TitleRow key={item.app.applicationId} {...item} back={back} selection={selection} />
          ))}
        </ul>
      )}
      {remaining > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => setVisible((count) => count + TITLE_PAGE_SIZE)}
          >
            Show {Math.min(remaining, TITLE_PAGE_SIZE).toLocaleString()} more
          </Button>
          <span className="text-sm text-muted">
            Showing {shown.length.toLocaleString()} of {items.length.toLocaleString()}
          </span>
        </div>
      )}
    </>
  );
}
