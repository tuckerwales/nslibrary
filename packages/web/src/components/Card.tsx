import type { ReactNode } from "react";

/**
 * A panel grouping one part of a page. Give `title` for a headed card; rows in a `CardList`
 * run edge to edge underneath it.
 */
export function Card({
  id,
  title,
  count,
  description,
  actions,
  className = "",
  children,
}: {
  id?: string;
  title?: ReactNode;
  /** Beside the title, like a Count. */
  count?: ReactNode;
  description?: ReactNode;
  /** Buttons at the right of the title. */
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section
      id={id}
      className={`scroll-mt-20 rounded-lg border border-line bg-panel shadow-card ${className}`}
    >
      {(title || description || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4 md:px-5 md:pt-5">
          <div className="min-w-0 max-w-[65ch]">
            {title && (
              <h2 className="flex flex-wrap items-center gap-2 text-xl">
                {title}
                {count}
              </h2>
            )}
            {description && <div className="mt-1 text-muted">{description}</div>}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Padding for content inside a Card that isn't a CardList. */
export function CardBody({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={`px-4 py-4 md:px-5 md:pb-5 ${className}`}>{children}</div>;
}

/** Rows inside a Card, divided by hairlines. */
export function CardList({
  as: Tag = "ul",
  className = "",
  children,
}: {
  as?: "ul" | "ol";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag className={`mt-3 divide-y divide-line border-t border-line ${className}`}>{children}</Tag>
  );
}

/** Padding for one CardList row. */
export const cardRow = "px-4 py-3 md:px-5";
