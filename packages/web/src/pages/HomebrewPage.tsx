import { useHomebrew } from "../api";
import { LoadError, PageHeader } from "../components/PageHeader";
import { TitleIcon } from "../components/TitleIcon";
import { formatBytes } from "../format";

export function HomebrewPage() {
  const homebrew = useHomebrew();

  return (
    <>
      <PageHeader title="Homebrew">
        <p>Homebrew apps (.nro files) found in your library folders.</p>
      </PageHeader>
      {homebrew.error ? (
        <LoadError error={homebrew.error} />
      ) : !homebrew.data ? null : homebrew.data.length === 0 ? (
        <p className="text-muted">No homebrew apps found yet.</p>
      ) : (
        <ul className="border-t border-line">
          {homebrew.data.map((app) => (
            <li
              key={app.fileId}
              className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-x-4 border-b border-line px-2 py-3 md:grid-cols-[44px_minmax(0,1fr)_5.5rem]"
            >
              <TitleIcon name={app.name} seed={String(app.fileId)} url={app.iconUrl} />
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold semi-condensed">
                  {app.name}
                  {app.version && (
                    <span className="ml-2 text-sm font-normal text-muted">{app.version}</span>
                  )}
                </p>
                <p className="truncate text-sm text-muted">
                  {app.publisher ? `${app.publisher}, ` : ""}
                  {app.relPath}
                </p>
              </div>
              <span className="hidden text-right text-sm text-muted md:block">
                {formatBytes(app.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
