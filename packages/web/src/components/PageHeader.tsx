import type { ReactNode } from "react";
import { usePageTitle } from "../format";

export function PageHeader({
  title,
  actions,
  children,
}: {
  title: string;
  /** Buttons for the whole page, beside the title on wide screens. */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  usePageTitle(title);
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 md:mb-8">
      <div className="min-w-0">
        <h1 tabIndex={-1} className="text-2xl outline-none md:text-3xl">
          {title}
        </h1>
        {children && <div className="mt-2 max-w-[65ch] text-muted">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}
