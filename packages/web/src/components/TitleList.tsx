import type { AppSummary } from "@nslib/shared";
import { useState } from "react";
import { Link } from "react-router";
import { formatBytes } from "../format";
import { Button } from "./Button";
import { ContentStrip } from "./ContentStrip";
import { TitleIcon } from "./TitleIcon";

/** Rows rendered at a time; large libraries grow on request instead of all at once. */
export const TITLE_PAGE_SIZE = 100;

export interface TitleListItem {
  app: AppSummary;
  /** Shown under the name instead of the title ID. */
  detail?: string;
}

function TitleRow({ app, detail }: TitleListItem) {
  return (
    <li className="border-b border-line">
      <Link
        to={`/apps/${app.applicationId}`}
        className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 px-2 py-3 hover:bg-panel md:grid-cols-[44px_minmax(0,1fr)_auto_5.5rem]"
      >
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
      </Link>
    </li>
  );
}

export type TitleLayout = "list" | "grid";

/** A cover-art card, like the Switch app's library grid. */
function TitleCard({ app, detail }: TitleListItem) {
  return (
    <li>
      <Link
        to={`/apps/${app.applicationId}`}
        className="flex h-full flex-col gap-2 rounded-lg p-2 hover:bg-panel"
      >
        <TitleIcon name={app.name} seed={app.applicationId} url={app.iconUrl} size="fill" />
        <span className="min-w-0">
          <span className="block truncate font-semibold semi-condensed" title={app.name}>
            {app.name}
          </span>
          <span className="block truncate text-sm text-muted">
            {detail ?? formatBytes(app.totalSize)}
          </span>
        </span>
        <ContentStrip app={app} />
      </Link>
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
}: {
  items: TitleListItem[];
  layout?: TitleLayout;
}) {
  const [visible, setVisible] = useState(TITLE_PAGE_SIZE);
  const shown = items.slice(0, visible);
  const remaining = items.length - shown.length;

  return (
    <>
      {layout === "grid" ? (
        <ul className="-mx-2 grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-y-2">
          {shown.map((item) => (
            <TitleCard key={item.app.applicationId} {...item} />
          ))}
        </ul>
      ) : (
        <ul className="border-t border-line">
          {shown.map((item) => (
            <TitleRow key={item.app.applicationId} {...item} />
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
