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

/**
 * A list of titles linking to their pages. Give it a `key` that changes with the search so the
 * visible count starts over.
 */
export function TitleList({ items }: { items: TitleListItem[] }) {
  const [visible, setVisible] = useState(TITLE_PAGE_SIZE);
  const shown = items.slice(0, visible);
  const remaining = items.length - shown.length;

  return (
    <>
      <ul className="border-t border-line">
        {shown.map((item) => (
          <TitleRow key={item.app.applicationId} {...item} />
        ))}
      </ul>
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
