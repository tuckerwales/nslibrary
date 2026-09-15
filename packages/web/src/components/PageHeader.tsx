import type { ReactNode } from "react";
import { usePageTitle } from "../format";

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  usePageTitle(title);
  return (
    <header className="mb-6 md:mb-8">
      <h1 className="text-2xl md:text-3xl">{title}</h1>
      {children && <div className="mt-2 max-w-[65ch] text-muted">{children}</div>}
    </header>
  );
}

export function LoadError({ error }: { error: Error }) {
  return (
    <p role="alert" className="text-danger">
      {error.message}
    </p>
  );
}
