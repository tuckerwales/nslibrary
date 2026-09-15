import type { AppContent, AppFlag, LibraryFileInfo, VerifyTask } from "@nslib/shared";
import { Link, useParams } from "react-router";
import {
  ApiRequestError,
  useApp,
  useCancelVerify,
  useRootPaths,
  useStartVerify,
  useVerifyTask,
} from "../api";
import { Button } from "../components/Button";
import { ContentStrip } from "../components/ContentStrip";
import { LoadError, Loading } from "../components/Feedback";
import { FileName } from "../components/FileName";
import { SendToSwitch } from "../components/SendToSwitch";
import { TitleIcon } from "../components/TitleIcon";
import {
  FORMAT_LABEL,
  formatBytes,
  SOURCE_LABEL,
  updateLabel,
  usePageTitle,
  VERIFY_LABEL,
} from "../format";

const FLAG_NOTES: Record<AppFlag, string> = {
  "no-base": "The base game isn't in your library. Updates and DLC need it to play.",
  duplicate:
    "Some content is in more than one file. You can delete the extra copies to save space.",
  "superseded-updates": "Older updates are still in your library. Only the newest one is needed.",
  "guessed-dlc-base":
    "Some DLC was matched to this game by its title ID. That's usually right, but it isn't confirmed.",
  "unknown-version":
    "An update's file name doesn't include its version, so it can't be compared with other updates.",
  "update-available": "A newer update is listed than any file in your library.",
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

function verifyProgressText(task: VerifyTask): string {
  if (task.state === "queued") return "Waiting to verify…";
  if (task.bytesTotal <= 0) return "Verifying…";
  return `Verifying ${Math.floor((task.bytesDone / task.bytesTotal) * 100)}%`;
}

function FileRow({ file, rootPath }: { file: LibraryFileInfo; rootPath: string | undefined }) {
  // Verifies run on the server in the background, so they survive leaving this page.
  const task = useVerifyTask(file.id).data ?? null;
  const start = useStartVerify();
  const cancel = useCancelVerify();
  const active = task?.state === "queued" || task?.state === "running";
  const status = file.verifyStatus;
  const label = VERIFY_LABEL[status];
  const failures =
    task?.state === "done" ? (task.result?.items.filter((item) => !item.ok) ?? []) : [];
  const errors = [
    task?.state === "failed" ? task.error : null,
    start.error?.message,
    cancel.error?.message,
  ].filter((message): message is string => Boolean(message));

  return (
    <li className="border-t border-line py-2.5 first:border-t-0">
      <div className="flex flex-col gap-1 sm:grid sm:grid-cols-[minmax(0,1fr)_3rem_4.5rem_9rem_7rem_auto] sm:items-baseline sm:gap-x-6">
        <FileName file={file} rootPath={rootPath} />
        <span className="flex flex-wrap gap-3 text-sm text-muted sm:contents">
          <span className="sm:text-ink">{FORMAT_LABEL[file.format]}</span>
          <span className="sm:text-right sm:text-ink">{formatBytes(file.size)}</span>
          <span>{file.metadataSource ? SOURCE_LABEL[file.metadataSource] : ""}</span>
          <span className={active ? "text-muted" : label.className} aria-live="polite">
            {active ? verifyProgressText(task) : label.text}
          </span>
          <span className="sm:justify-self-end">
            {active ? (
              <Button
                variant="ghost"
                className="h-8 px-2"
                disabled={cancel.isPending}
                aria-label={`Cancel verify: ${file.relPath}`}
                onClick={() => cancel.mutate(file.id)}
              >
                Cancel
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="h-8 px-2"
                disabled={start.isPending}
                aria-label={`${status === "unverified" ? "Verify" : "Verify again"}: ${file.relPath}`}
                onClick={() => start.mutate({ id: file.id })}
              >
                {status === "unverified" ? "Verify" : "Verify again"}
              </Button>
            )}
          </span>
        </span>
      </div>
      {errors.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-sm text-danger">
          {errors.map((message) => (
            <li key={message} className="[overflow-wrap:anywhere]">
              {message}
            </li>
          ))}
        </ul>
      )}
      {failures.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-sm text-danger">
          {failures.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: file-level messages have no NCA ID
            <li key={`${item.ncaId}:${index}`} className="[overflow-wrap:anywhere]">
              {item.ncaId ? `${item.ncaId}: ${item.message}` : item.message}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function AppPage() {
  const { applicationId = "" } = useParams();
  const app = useApp(applicationId);
  const rootPaths = useRootPaths();
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
  if (!app.data) {
    return (
      <>
        {back}
        <Loading className="mt-6" />
      </>
    );
  }
  const detail = app.data;

  return (
    <>
      {back}
      <header className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-start">
        <TitleIcon name={detail.name} seed={detail.applicationId} url={detail.iconUrl} size={96} />
        <div className="min-w-0">
          <h1 tabIndex={-1} className="text-2xl break-words outline-none md:text-3xl">
            {detail.name}
          </h1>
          <p className="mt-1 text-muted">
            {detail.applicationId}
            {detail.publisher && <span>, {detail.publisher}</span>}
          </p>
          <div className="mt-4">
            <ContentStrip app={detail} size="lg" />
          </div>
        </div>
      </header>

      <SendToSwitch contents={detail.contents} />

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
                  <div key={content.contentMetaId} className="border-b border-line py-3">
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
                        {content.applicationIdSource === "titledb" && (
                          <span className="text-sm text-muted">Matched by title database</span>
                        )}
                      </div>
                    )}
                    <ul>
                      {content.files.map((file) => (
                        <FileRow key={file.id} file={file} rootPath={rootPaths.get(file.rootId)} />
                      ))}
                    </ul>
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
