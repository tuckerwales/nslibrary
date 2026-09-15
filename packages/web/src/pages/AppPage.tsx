import type { AppContent, AppFlag, LibraryFileInfo } from "@nslib/shared";
import { Link, useParams } from "react-router";
import { ApiRequestError, useApp, useRoots } from "../api";
import { ContentStrip } from "../components/ContentStrip";
import { FileName } from "../components/FileName";
import { LoadError } from "../components/PageHeader";
import { TitleIcon } from "../components/TitleIcon";
import { FORMAT_LABEL, formatBytes, SOURCE_LABEL, updateLabel, usePageTitle } from "../format";

const FLAG_NOTES: Record<AppFlag, string> = {
  "no-base": "The base game isn't in your library. Updates and DLC need it to play.",
  duplicate:
    "Some content is in more than one file. You can delete the extra copies to save space.",
  "superseded-updates": "Older updates are still in your library. Only the newest one is needed.",
  "guessed-dlc-base":
    "Some DLC was matched to this game by its title ID. That's usually right, but it isn't confirmed.",
  "unknown-version":
    "An update's file name doesn't include its version, so it can't be compared with other updates.",
};

const SECTIONS: { type: AppContent["type"]; title: string; empty: string }[] = [
  { type: "application", title: "Base game", empty: "Not in your library." },
  { type: "patch", title: "Updates", empty: "No updates." },
  { type: "addon", title: "DLC", empty: "No DLC." },
];

function contentTitle(content: AppContent): string {
  switch (content.type) {
    case "application":
      return "Base game";
    case "patch":
      return content.version === null ? "Update, version unknown" : updateLabel(content.version);
    case "addon":
      return content.name;
  }
}

function FileList({
  files,
  rootPaths,
}: {
  files: LibraryFileInfo[];
  rootPaths: Map<number, string>;
}) {
  return (
    <ul>
      {files.map((file) => (
        <li
          key={file.id}
          className="flex flex-col gap-1 border-t border-line py-2.5 first:border-t-0 sm:grid sm:grid-cols-[minmax(0,1fr)_3rem_4.5rem_9rem] sm:items-baseline sm:gap-x-6"
        >
          <FileName file={file} rootPath={rootPaths.get(file.rootId)} />
          <span className="flex gap-3 text-sm text-muted sm:contents">
            <span className="sm:text-ink">{FORMAT_LABEL[file.format]}</span>
            <span className="sm:text-right sm:text-ink">{formatBytes(file.size)}</span>
            <span>{file.metadataSource ? SOURCE_LABEL[file.metadataSource] : ""}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function AppPage() {
  const { applicationId = "" } = useParams();
  const app = useApp(applicationId);
  const rootPaths = new Map((useRoots().data ?? []).map((root) => [root.id, root.path]));
  usePageTitle(app.data?.name);

  const back = (
    <Link to="/" className="text-sm text-muted hover:text-ink">
      Back to library
    </Link>
  );

  if (app.error) {
    const gone = app.error instanceof ApiRequestError && app.error.status === 404;
    return (
      <>
        {back}
        <div className="mt-6">
          {gone ? (
            <p className="text-muted">This title isn't in your library anymore.</p>
          ) : (
            <LoadError error={app.error} />
          )}
        </div>
      </>
    );
  }
  if (!app.data) return back;
  const detail = app.data;

  return (
    <>
      {back}
      <header className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-start">
        <TitleIcon name={detail.name} seed={detail.applicationId} url={detail.iconUrl} size={96} />
        <div className="min-w-0">
          <h1 className="text-2xl break-words md:text-3xl">{detail.name}</h1>
          <p className="mt-1 text-muted">
            {detail.applicationId}
            {detail.publisher && <span>, {detail.publisher}</span>}
          </p>
          <div className="mt-4">
            <ContentStrip app={detail} size="lg" />
          </div>
        </div>
      </header>

      {detail.flags.length > 0 && (
        <ul className="mt-8 max-w-[70ch] space-y-2">
          {detail.flags.map((flag) => (
            <li key={flag} className="border-l-2 border-dlc pl-3">
              {FLAG_NOTES[flag]}
            </li>
          ))}
        </ul>
      )}

      {SECTIONS.map(({ type, title, empty }) => {
        const contents = detail.contents.filter((c) => c.type === type);
        return (
          <section key={type} className="mt-10">
            <h2 className="text-xl">{title}</h2>
            {contents.length === 0 ? (
              <p className="mt-2 text-muted">{empty}</p>
            ) : (
              <div className="mt-3 border-t border-line">
                {contents.map((content) => (
                  <div
                    key={`${content.titleId}:${content.version}`}
                    className="border-b border-line py-3"
                  >
                    {type !== "application" && (
                      <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
                        <h3 className="text-lg">{contentTitle(content)}</h3>
                        <span className="text-sm text-muted">
                          {content.titleId}
                          {content.version !== null && type === "patch" && `, v${content.version}`}
                        </span>
                        {content.applicationIdSource === "guess" && (
                          <span className="text-sm text-dlc">Matched by title ID</span>
                        )}
                      </div>
                    )}
                    <FileList files={content.files} rootPaths={rootPaths} />
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
