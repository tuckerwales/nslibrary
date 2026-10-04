import type { AppContent, AppDetail, AppFlag, LibraryFileInfo, VerifyTask } from "@nslib/shared";
import { Link, useLocation, useParams } from "react-router";
import {
  ApiRequestError,
  isCompressActive,
  useApp,
  useCancelVerify,
  useCompressSettings,
  useCompressTask,
  useRootPaths,
  useSaveBackups,
  useStartCompress,
  useStartVerify,
  useVerifyTask,
  useVerifyTasks,
} from "../api";
import { Badge, Count } from "../components/Badge";
import { Button, ButtonLink } from "../components/Button";
import { Callout } from "../components/Callout";
import { Card, CardBody, cardRow } from "../components/Card";
import { CompressHeadline, CompressOutcome, CompressProgress } from "../components/CompressStatus";
import { ContentStrip } from "../components/ContentStrip";
import { LoadError, Loading } from "../components/Feedback";
import { fileLocation } from "../components/FileName";
import { Icon } from "../components/Icon";
import { ProgressBar } from "../components/ProgressBar";
import { RelativeTime } from "../components/RelativeTime";
import { SendToSwitch } from "../components/SendToSwitch";
import { TitleIcon } from "../components/TitleIcon";
import type { BackState } from "../components/TitleList";
import {
  FORMAT_LABEL,
  firmwareLabel,
  formatBytes,
  plural,
  SOURCE_LABEL,
  updateLabel,
  usePageTitle,
  VERIFY_LABEL,
} from "../format";

const FLAG_NOTES: Record<AppFlag, string> = {
  "no-base": "The base game isn't in your library. Updates and DLC need it to play.",
  duplicate:
    "Some content is in more than one file. The copies are marked Duplicate below; you can delete the extras to save space.",
  "superseded-updates":
    "Older updates are still in your library, marked Older update below. Only the newest one is needed.",
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

/** Where the back link goes and what it says, from the list the title was opened from. */
const BACK_LABELS: [prefix: string, label: string][] = [
  ["/switch", "On this Switch"],
  ["/problems", "Problems"],
];

function backLink(state: unknown): { to: string; label: string } {
  const back = (state as Partial<BackState> | null)?.back;
  if (typeof back !== "string" || !back.startsWith("/")) return { to: "/", label: "library" };
  const label = BACK_LABELS.find(([prefix]) => back.startsWith(prefix))?.[1] ?? "library";
  return { to: back, label };
}

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

function verifyProgress(task: VerifyTask): number | null {
  if (task.state === "queued" || task.bytesTotal <= 0) return null;
  return Math.floor((task.bytesDone / task.bytesTotal) * 100);
}

function verifyProgressText(task: VerifyTask): string {
  if (task.state === "queued") return "Waiting to verify…";
  const percent = verifyProgress(task);
  return percent === null ? "Verifying…" : `Verifying ${percent}%`;
}

const present = (files: LibraryFileInfo[]) => files.filter((f) => f.missingSince === null);

/** Moves to a marked row, for the "Show" buttons beside the title's problems. */
function showElement(id: string) {
  const element = document.getElementById(id);
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.focus({ preventScroll: true });
}

/** Where each problem's rows are, so its note can point at them. */
function flagTargets(detail: AppDetail): Partial<Record<AppFlag, string>> {
  const duplicate = detail.contents.find((c) => present(c.files).length > 1);
  const newest = Math.max(
    -1,
    ...detail.contents.filter((c) => c.type === "patch").map((c) => c.version ?? -1),
  );
  const older = detail.contents.find(
    (c) => c.type === "patch" && c.version !== null && c.version < newest,
  );
  return {
    ...(duplicate && { duplicate: `content-${duplicate.contentMetaId}` }),
    ...(older && { "superseded-updates": `content-${older.contentMetaId}` }),
  };
}

/** How many save backups the server holds for this game, with a link to them. */
function SaveBackupsSummary({ applicationId }: { applicationId: string }) {
  const saves = useSaveBackups();
  if (!saves.data) return null;
  const backups = saves.data.filter((backup) => backup.applicationId === applicationId);
  const newest = backups[0];
  return (
    <Card title="Save backups">
      <CardBody>
        {newest ? (
          <p className="text-muted">
            {plural(backups.length, "backup")}, the newest{" "}
            <RelativeTime timestamp={newest.createdAt} />.{" "}
            <Link to={`/saves?app=${applicationId}`} className="text-accent hover:underline">
              View saves
            </Link>
          </p>
        ) : (
          <p className="text-muted">
            None yet. Back up this game's save from the Saves tab of the NSLibrary app on a Switch.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function FileRow({
  file,
  rootPath,
  hasNsz,
  duplicate,
}: {
  file: LibraryFileInfo;
  rootPath: string | undefined;
  /** The same content is in the library as NSZ already. */
  hasNsz: boolean;
  /** Another file holds the same content. */
  duplicate: boolean;
}) {
  // Verifies run on the server in the background, so they survive leaving this page.
  const task = useVerifyTask(file.id).data ?? null;
  const start = useStartVerify();
  const cancel = useCancelVerify();
  const active = task?.state === "queued" || task?.state === "running";
  const status = file.verifyStatus;
  const label = VERIFY_LABEL[status];
  const failures =
    task?.state === "done" ? (task.result?.items.filter((item) => !item.ok) ?? []) : [];
  const compressTask = useCompressTask(file.id).data ?? null;
  const compressReady = useCompressSettings().data?.problem === null;
  const startCompress = useStartCompress();
  const compressing = isCompressActive(compressTask);
  const missing = file.missingSince !== null;
  // Offered for NSP files that have no NSZ copy yet and aren't being (or haven't just been) done.
  const offerCompress =
    file.format === "nsp" && !missing && !hasNsz && !compressing && compressTask?.state !== "done";
  const errors = [
    task?.state === "failed" ? task.error : null,
    start.error?.message,
    cancel.error?.message,
    startCompress.error?.message,
  ].filter((message): message is string => Boolean(message));
  const { name, folder, fullPath } = fileLocation(file.relPath, rootPath);

  return (
    <li className="border-t border-line/70 py-3 first:border-t-0 first:pt-2 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="[overflow-wrap:anywhere]" title={fullPath}>
              {name}
            </span>
            {missing ? (
              <Badge tone="danger">Missing</Badge>
            ) : (
              <span aria-live="polite">
                <Badge tone={active ? "accent" : label.tone}>
                  {active ? verifyProgressText(task) : label.text}
                </Badge>
              </span>
            )}
            {duplicate && (
              <Badge tone="warning" title="Another file holds the same content">
                Duplicate
              </Badge>
            )}
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-sm text-muted">
            <span className="font-semibold text-ink">{FORMAT_LABEL[file.format]}</span>
            <span>{formatBytes(file.size)}</span>
            {folder && (
              <span className="min-w-0 [overflow-wrap:anywhere]" title={fullPath}>
                in {folder}
              </span>
            )}
            {file.metadataSource && (
              <span className="hidden md:inline">· {SOURCE_LABEL[file.metadataSource]}</span>
            )}
          </p>
        </div>
        {/* Ghost buttons carry their own padding; the negative margin lines their text up. */}
        {!missing && (
          <div className="-ml-2 flex shrink-0 flex-wrap gap-1 sm:-mr-2 sm:ml-0">
            {offerCompress &&
              (compressReady ? (
                <Button
                  variant="ghost"
                  className="h-8 px-2"
                  disabled={startCompress.isPending}
                  aria-label={`Compress to NSZ: ${file.relPath}`}
                  onClick={() => startCompress.mutate(file.id)}
                >
                  Compress
                </Button>
              ) : (
                // Compressing needs keys and a folder first; that page walks through both.
                <ButtonLink
                  to="/compression"
                  variant="ghost"
                  className="h-8 px-2"
                  aria-label={`Compress to NSZ (set up first): ${file.relPath}`}
                >
                  Compress
                </ButtonLink>
              ))}
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
          </div>
        )}
      </div>
      {task?.state === "running" && (
        <ProgressBar
          className="mt-2 max-w-md"
          percent={verifyProgress(task)}
          label={`Verifying ${name}`}
        />
      )}
      {compressTask && (
        <div className="mt-2 rounded-md bg-ground px-3 py-2">
          {compressing ? (
            <>
              <p className="text-sm font-semibold">Compressing to NSZ</p>
              <CompressProgress task={compressTask} />
            </>
          ) : (
            <>
              <p className="text-sm">
                <CompressHeadline task={compressTask} />
              </p>
              <CompressOutcome task={compressTask} />
            </>
          )}
        </div>
      )}
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

/** Starts a verify for every file on disk that isn't already being checked. */
function VerifyAllButton({ files }: { files: LibraryFileInfo[] }) {
  const tasks = useVerifyTasks().data ?? [];
  const start = useStartVerify();
  const busy = new Set(
    tasks
      .filter((task) => task.state === "queued" || task.state === "running")
      .map((task) => task.fileId),
  );
  const waiting = present(files).filter((file) => !busy.has(file.id));
  if (present(files).length < 2) return null;
  return (
    <Button
      variant="secondary"
      disabled={waiting.length === 0}
      onClick={() => {
        for (const file of waiting) start.mutate({ id: file.id });
      }}
    >
      {waiting.length === 0 ? "Verifying all files…" : "Verify all files"}
    </Button>
  );
}

export function AppPage() {
  const { applicationId = "" } = useParams();
  const location = useLocation();
  const app = useApp(applicationId);
  const rootPaths = useRootPaths();
  usePageTitle(app.data?.name);
  const backTo = backLink(location.state);

  const back = (
    <Link
      to={backTo.to}
      className="-ml-1 inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-sm font-semibold text-muted hover:text-ink"
    >
      <Icon name="back" size={16} />
      Back to {backTo.label}
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
  const allFiles = detail.contents.flatMap((c) => c.files);
  const firmware = Math.max(0, ...detail.contents.map((c) => c.requiredSystemVersion ?? 0));
  const targets = flagTargets(detail);
  const newestUpdate = Math.max(
    -1,
    ...detail.contents.filter((c) => c.type === "patch").map((c) => c.version ?? -1),
  );
  const facts = [
    formatBytes(detail.totalSize),
    plural(detail.fileCount, "file"),
    firmware > 0 ? `Needs firmware ${firmwareLabel(firmware)}` : null,
  ].filter(Boolean);

  return (
    <>
      {back}
      <header className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start">
        <span className="self-start rounded-md shadow-card">
          <TitleIcon
            name={detail.name}
            seed={detail.applicationId}
            url={detail.iconUrl}
            size={112}
          />
        </span>
        <div className="min-w-0 flex-1">
          <h1 tabIndex={-1} className="text-2xl break-words outline-none md:text-3xl">
            {detail.name}
          </h1>
          <p className="mt-1 text-muted">
            {detail.publisher && <span className="text-ink">{detail.publisher} · </span>}
            {detail.applicationId}
          </p>
          <div className="mt-3">
            <ContentStrip app={detail} size="lg" />
          </div>
          <p className="mt-3 text-sm text-muted">{facts.join(" · ")}</p>
        </div>
        <div className="flex gap-2 sm:self-end">
          <VerifyAllButton files={allFiles} />
        </div>
      </header>

      {detail.flags.length > 0 && (
        <Callout className="mt-6">
          <h2 className="sr-only">Things to check</h2>
          <ul className="space-y-1.5">
            {detail.flags.map((flag) => {
              const target = targets[flag];
              return (
                <li key={flag}>
                  {FLAG_NOTES[flag]}
                  {target && (
                    <button
                      type="button"
                      className="ml-2 text-sm font-semibold text-accent hover:underline"
                      onClick={() => showElement(target)}
                    >
                      Show
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </Callout>
      )}

      <div className="mt-8 flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <aside className="lg:sticky lg:top-10 lg:order-2">
          <SendToSwitch contents={detail.contents} />
        </aside>

        <div className="flex min-w-0 flex-col gap-6">
          {SECTIONS.map(({ type, title, empty }) => {
            const contents = detail.contents.filter((c) => c.type === type);
            return (
              <Card
                key={type}
                title={title}
                count={contents.length > 1 ? <Count value={contents.length} /> : undefined}
              >
                {contents.length === 0 ? (
                  <p className={`${cardRow} pt-1 pb-4 text-muted`}>{empty}</p>
                ) : (
                  <ul className="mt-3 divide-y divide-line border-t border-line">
                    {contents.map((content) => {
                      const older =
                        type === "patch" &&
                        content.version !== null &&
                        content.version < newestUpdate;
                      const duplicate = present(content.files).length > 1;
                      return (
                        <li
                          key={content.contentMetaId}
                          id={`content-${content.contentMetaId}`}
                          tabIndex={-1}
                          className={`${cardRow} scroll-mt-20 outline-none focus-visible:bg-accent/5`}
                        >
                          {type !== "application" && (
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <h3 className="text-lg">{contentTitle(content)}</h3>
                              <span className="text-sm text-muted">
                                {content.titleId}
                                {content.version !== null &&
                                  type === "patch" &&
                                  ` · v${content.version}`}
                              </span>
                              {older && (
                                <Badge tone="warning" title="Only the newest update is needed">
                                  Older update
                                </Badge>
                              )}
                              {content.applicationIdSource === "guess" && (
                                <Badge tone="warning">Matched by title ID</Badge>
                              )}
                              {content.applicationIdSource === "titledb" && (
                                <Badge>Matched by title database</Badge>
                              )}
                            </div>
                          )}
                          <ul>
                            {content.files.map((file) => (
                              <FileRow
                                key={file.id}
                                file={file}
                                rootPath={rootPaths.get(file.rootId)}
                                hasNsz={content.files.some((other) => other.format === "nsz")}
                                duplicate={duplicate && file.missingSince === null}
                              />
                            ))}
                          </ul>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            );
          })}
          <SaveBackupsSummary applicationId={detail.applicationId} />
        </div>
      </div>
    </>
  );
}
