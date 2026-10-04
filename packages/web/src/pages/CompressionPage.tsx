import type {
  CompressCandidate,
  CompressFolderOption,
  CompressSettings,
  CompressTask,
} from "@nslib/shared";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Link } from "react-router";
import {
  isCompressActive,
  useClearFinishedCompressions,
  useCompressCandidates,
  useCompressFolders,
  useCompressSettings,
  useCompressTasks,
  usePutCompressSettings,
  useRootPaths,
  useStartCompress,
  useStartCompressMany,
} from "../api";
import { Count } from "../components/Badge";
import { Button, ButtonLink } from "../components/Button";
import { Card, CardBody, CardList, cardRow } from "../components/Card";
import { CompressHeadline, CompressOutcome, CompressProgress } from "../components/CompressStatus";
import { ErrorText, LoadError, Loading } from "../components/Feedback";
import { inputClass, Switch } from "../components/Field";
import { FileName } from "../components/FileName";
import { PageHeader } from "../components/PageHeader";
import { Select } from "../components/Select";
import { COMPRESS_LEVELS, estimatedSavingText, levelLabel, savingsSummary } from "../compress";
import { formatBytes, plural, updateLabel } from "../format";

const OTHER = "other";

function HowItWorks() {
  const steps = [
    ["Compress", "The server makes a smaller NSZ copy of an NSP."],
    ["Check", "Every part of the NSZ is compared with the original. Only an exact match is kept."],
    ["Free space", "Delete the NSP. The Switch installs the NSZ just the same."],
  ];
  return (
    <ol className="grid max-w-3xl gap-3 sm:grid-cols-3">
      {steps.map(([title, text], index) => (
        <li key={title} className="rounded-lg border border-line bg-panel p-3 shadow-card">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <span
              aria-hidden="true"
              className="inline-grid size-5 place-items-center rounded-full bg-accent/15 text-xs text-accent"
            >
              {index + 1}
            </span>
            <span className="sr-only">{index + 1}.</span>
            {title}
          </p>
          <p className="mt-0.5 text-sm text-muted">{text}</p>
        </li>
      ))}
    </ol>
  );
}

function folderLabel(option: CompressFolderOption): string {
  return option.path === option.rootPath
    ? "The library folder itself"
    : `A new "${option.path.slice(option.rootPath.length + 1)}" folder in the library folder`;
}

/** Radio choices of folders the server can write to, plus one typed by hand. */
function FolderChooser({ current, onSaved }: { current: string | null; onSaved?: () => void }) {
  const folders = useCompressFolders();
  const put = usePutCompressSettings();
  const name = useId();
  const options = folders.data ?? [];
  const known = current !== null && options.some((option) => option.path === current);
  const firstWritable = options.find((option) => option.writable)?.path;
  const [choice, setChoice] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const selected = choice ?? (current ? (known ? current : OTHER) : (firstWritable ?? OTHER));
  const otherPath = typed ?? (known ? "" : (current ?? ""));
  const canPick = typeof window !== "undefined" && window.nslib !== undefined;

  const target = selected === OTHER ? otherPath.trim() : selected;
  const chosen = options.find((option) => option.path === target);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!target) return;
    put.mutate(
      { outputDir: target, createOutputDir: chosen ? !chosen.exists : false },
      { onSuccess: () => onSaved?.() },
    );
  };

  if (folders.error) return <LoadError error={folders.error} />;
  if (!folders.data) return <Loading />;

  return (
    <form onSubmit={submit} className="mt-3 max-w-2xl">
      <fieldset>
        <legend className="sr-only">Where to save NSZ files</legend>
        <div className="space-y-2">
          {options.map((option) => (
            <label
              key={option.path}
              className={`flex items-start gap-3 rounded-md border p-3 transition-colors ${
                selected === option.path ? "border-accent bg-accent/5" : "border-line"
              } ${option.writable ? "cursor-pointer hover:border-muted" : "opacity-60"}`}
            >
              <input
                type="radio"
                name={name}
                className="mt-1"
                value={option.path}
                disabled={!option.writable}
                checked={selected === option.path}
                onChange={() => {
                  setChoice(option.path);
                  put.reset();
                }}
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">
                  {folderLabel(option)}
                  {option.path !== option.rootPath && option.writable && (
                    <span className="font-normal text-muted"> (recommended)</span>
                  )}
                </span>
                <span className="block text-sm break-all text-muted">{option.path}</span>
                {!option.writable && (
                  <span className="block text-sm text-dlc">
                    The server can only read here (a read-only mount).
                  </span>
                )}
                {option.writable && !option.exists && (
                  <span className="block text-sm text-muted">It will be created.</span>
                )}
              </span>
            </label>
          ))}
          <label
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors hover:border-muted ${
              selected === OTHER ? "border-accent bg-accent/5" : "border-line"
            }`}
          >
            <input
              type="radio"
              name={name}
              className="mt-1"
              value={OTHER}
              checked={selected === OTHER}
              onChange={() => {
                setChoice(OTHER);
                put.reset();
              }}
            />
            <span className="block min-w-0 flex-1">
              <span className="block text-sm font-semibold">Another folder on the server</span>
              {selected === OTHER && (
                <span className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input
                    aria-label="Folder path"
                    className={inputClass}
                    placeholder="/library/nsz"
                    value={otherPath}
                    onChange={(event) => {
                      setTyped(event.target.value);
                      put.reset();
                    }}
                  />
                  {canPick && (
                    <Button
                      variant="secondary"
                      onClick={async () => {
                        const picked = await window.nslib?.pickFolder();
                        if (picked) setTyped(picked);
                      }}
                    >
                      Browse…
                    </Button>
                  )}
                </span>
              )}
            </span>
          </label>
        </div>
      </fieldset>
      {options.length > 0 && options.every((option) => !option.writable) && (
        <p className="mt-3 text-sm text-muted">
          All your library folders are read-only to the server. In Docker, mount a writable folder
          as <code>/library/nsz</code> (without <code>:ro</code>), restart, and it appears here.
        </p>
      )}
      <Button type="submit" className="mt-3" disabled={put.isPending || !target}>
        {put.isPending ? "Saving…" : "Save NSZ files here"}
      </Button>
      <ErrorText>{put.error?.message}</ErrorText>
    </form>
  );
}

function StepItem({
  number,
  done,
  title,
  children,
}: {
  number: number;
  done: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className={`${cardRow} py-4`}>
      <h3 className="flex items-baseline gap-2 text-lg">
        <span
          aria-hidden="true"
          className={`inline-grid size-6 shrink-0 place-items-center rounded-full text-sm font-semibold ${
            done ? "bg-update text-panel" : "bg-line text-ink"
          }`}
        >
          {done ? "✓" : number}
        </span>
        {title}
        {done && <span className="sr-only">(done)</span>}
      </h3>
      <div className="mt-1 pl-8">{children}</div>
    </li>
  );
}

function SetupSteps({ settings }: { settings: CompressSettings }) {
  const folderReady = settings.outputDir !== null && settings.problem === null;
  return (
    <Card
      className="mt-6 max-w-3xl"
      title="Get set up"
      description="Two things to do once, then you can start compressing."
    >
      <CardList as="ol">
        <StepItem number={1} done={settings.keysReady} title="Add your console keys">
          {settings.keysReady ? (
            <p className="text-sm text-muted">Your prod.keys are loaded.</p>
          ) : (
            <>
              <p className="text-sm text-muted">
                NSLibrary needs the prod.keys from your own Switch to read your games and check each
                NSZ against them.
              </p>
              <ButtonLink to="/settings" variant="secondary" className="mt-2">
                Add prod.keys in Settings
              </ButtonLink>
            </>
          )}
        </StepItem>
        <StepItem number={2} done={folderReady} title="Choose where to save NSZ files">
          {settings.outputDir && settings.keysReady && settings.problem && (
            <p className="text-sm text-danger">{settings.problem}</p>
          )}
          <p className="text-sm text-muted">
            A folder inside your library is best, so new NSZ files are listed and the Switch can
            install them.
          </p>
          <FolderChooser current={settings.outputDir} />
        </StepItem>
      </CardList>
    </Card>
  );
}

/** The settings once everything works, folded to one line until you want to change them. */
function SettingsSummary({ settings }: { settings: CompressSettings }) {
  const put = usePutCompressSettings();
  const [editing, setEditing] = useState(false);
  const levelHint = COMPRESS_LEVELS.find((option) => option.level === settings.level)?.hint;
  const knownLevel = COMPRESS_LEVELS.some((option) => option.level === settings.level);

  return (
    <section className="mt-6 max-w-3xl rounded-lg border border-line bg-panel p-4 shadow-card md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">
            <span aria-hidden="true" className="text-update">
              ✓{" "}
            </span>
            Compression is set up
          </p>
          <p className="mt-0.5 text-sm text-muted">
            Saving to <span className="break-all">{settings.outputDir}</span>.{" "}
            {levelLabel(settings.level)} compression.{" "}
            {settings.removeOriginal
              ? "Each NSP is deleted once its NSZ checks out."
              : "NSP files are kept until you delete them."}
          </p>
          {!settings.outputInLibrary && (
            <p className="mt-1 text-sm text-dlc">
              This folder isn't in your library, so new NSZ files won't be listed or installable.
              Add it on the{" "}
              <Link to="/folders" className="underline">
                Folders
              </Link>{" "}
              page, or choose a folder inside your library.
            </p>
          )}
        </div>
        <Button variant="secondary" onClick={() => setEditing(!editing)} aria-expanded={editing}>
          {editing ? "Done" : "Change"}
        </Button>
      </div>

      {editing && (
        <div className="mt-4 border-t border-line pt-4">
          <h3 className="font-semibold">Where to save NSZ files</h3>
          <FolderChooser current={settings.outputDir} />

          <div className="mt-6 max-w-xs">
            <Select
              label="How hard to compress"
              value={knownLevel ? settings.level : ""}
              disabled={put.isPending}
              onChange={(event) => put.mutate({ level: Number(event.target.value) })}
            >
              {!knownLevel && <option value="">Level {settings.level}</option>}
              {COMPRESS_LEVELS.map((option) => (
                <option key={option.level} value={option.level}>
                  {option.label}
                </option>
              ))}
            </Select>
            {levelHint && <p className="mt-1 text-sm text-muted">{levelHint}</p>}
          </div>
          <div className="mt-6">
            <Switch
              label="Delete each NSP automatically once its NSZ checks out"
              hint="Off: you choose when to delete each one. Files on read-only folders are always kept."
              checked={settings.removeOriginal}
              disabled={put.isPending}
              onChange={(removeOriginal) => put.mutate({ removeOriginal })}
            />
          </div>
          <ErrorText>{put.error?.message}</ErrorText>
        </div>
      )}
    </section>
  );
}

function ActiveSection({ tasks }: { tasks: CompressTask[] }) {
  const active = tasks.filter(isCompressActive);
  if (active.length === 0) return null;
  // The list is newest first; the queue runs oldest first, and the running one leads.
  const ordered = [...active]
    .reverse()
    .sort((a, b) => Number(b.state === "running") - Number(a.state === "running"));
  const waiting = ordered.filter((task) => task.state === "queued").length;
  return (
    <Card
      className="mt-6"
      title="Compressing now"
      count={<Count value={active.length} />}
      description={`${waiting > 0 ? `${plural(waiting, "more file")} waiting. ` : ""}This carries on in the background, so you can leave this page.`}
    >
      <CardList>
        {ordered.map((task) => (
          <li key={task.fileId} className={cardRow}>
            <p className="font-semibold [overflow-wrap:anywhere]">{task.name}</p>
            <div className="text-sm">
              <FileName file={task} compact />
            </div>
            <CompressProgress task={task} compact={task.state === "queued"} />
          </li>
        ))}
      </CardList>
    </Card>
  );
}

function FinishedSection({ tasks }: { tasks: CompressTask[] }) {
  const clear = useClearFinishedCompressions();
  const finished = tasks.filter((task) => !isCompressActive(task));
  if (finished.length === 0) return null;
  const { freed, pending } = savingsSummary(finished);
  return (
    <Card
      className="mt-6"
      title="Finished"
      count={<Count value={finished.length} />}
      description={
        (freed > 0 || pending > 0) && (
          <p>
            {freed > 0 && `${formatBytes(freed)} saved. `}
            {pending > 0 &&
              `Deleting the NSP files that are still on disk would save ${formatBytes(pending)} more.`}
          </p>
        )
      }
      actions={
        <Button variant="ghost" disabled={clear.isPending} onClick={() => clear.mutate()}>
          Clear this list
        </Button>
      }
    >
      <CardList>
        {finished.map((task) => (
          <li key={task.fileId} className={cardRow}>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
              <p className="font-semibold [overflow-wrap:anywhere]">{task.name}</p>
              <CompressHeadline task={task} />
            </div>
            <div className="text-sm">
              <FileName file={task} compact />
            </div>
            <CompressOutcome task={task} />
          </li>
        ))}
      </CardList>
      <p className={`${cardRow} border-t border-line text-sm text-muted`}>
        This list is kept until the server restarts. The NSZ files stay either way.
      </p>
    </Card>
  );
}

function candidateLabel(candidate: CompressCandidate): string {
  if (candidate.type === "patch") {
    return `${candidate.name}, ${candidate.version === null ? "update" : updateLabel(candidate.version)}`;
  }
  if (candidate.type === "addon") return `${candidate.name} (DLC)`;
  return candidate.name;
}

function CandidateRow({
  candidate,
  rootPath,
  ready,
}: {
  candidate: CompressCandidate;
  rootPath: string | undefined;
  ready: boolean;
}) {
  const start = useStartCompress();
  return (
    <li className={cardRow}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <p className="font-semibold [overflow-wrap:anywhere]">{candidateLabel(candidate)}</p>
          <div className="text-sm">
            <FileName file={candidate.file} rootPath={rootPath} compact />
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-3 text-sm">
          <span className="text-muted">{formatBytes(candidate.file.size)}</span>
          {/* Until setup is done, the note above the list explains why nothing can start. */}
          {ready && (
            <Button
              variant="secondary"
              disabled={start.isPending}
              aria-label={`Compress ${candidateLabel(candidate)}`}
              onClick={() => start.mutate(candidate.file.id)}
            >
              Compress
            </Button>
          )}
        </span>
      </div>
      <ErrorText>{start.error?.message}</ErrorText>
    </li>
  );
}

function CandidatesSection({
  tasks,
  ready,
  keysReady,
}: {
  tasks: CompressTask[];
  ready: boolean;
  keysReady: boolean;
}) {
  const candidates = useCompressCandidates();
  const rootPaths = useRootPaths();
  const startMany = useStartCompressMany();
  const active = new Set(tasks.filter(isCompressActive).map((task) => task.fileId));

  if (candidates.error) return <LoadError error={candidates.error} />;
  if (!candidates.data) return <Loading className="mt-10" />;
  const all = candidates.data;
  const waiting = all.filter((candidate) => !active.has(candidate.file.id));
  const size = waiting.reduce((sum, candidate) => sum + candidate.file.size, 0);
  const skipped = startMany.data?.skipped ?? [];
  const nameOf = (fileId: number) => {
    const candidate = all.find((c) => c.file.id === fileId);
    return candidate ? candidateLabel(candidate) : `File ${fileId}`;
  };

  return (
    <Card className="mt-6" title="Ready to compress" count={<Count value={waiting.length} />}>
      {waiting.length === 0 ? (
        <p className={`${cardRow} max-w-[65ch] pt-1 pb-4 text-muted`}>
          {!keysReady
            ? "Once your keys are added, the NSP files you can compress are listed here."
            : all.length > 0
              ? "Everything left is already queued."
              : "Nothing to compress: every NSP in your library has an NSZ copy."}
        </p>
      ) : (
        <>
          <CardBody className="pt-1 pb-0 md:pb-0">
            <p className="max-w-[65ch] text-muted">
              {plural(waiting.length, "NSP file")} without an NSZ copy, {formatBytes(size)} in all.
              Compressing them usually saves {estimatedSavingText(size)}.
            </p>
            {ready ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  disabled={startMany.isPending}
                  onClick={() => startMany.mutate(waiting.map((candidate) => candidate.file.id))}
                >
                  {waiting.length === 1 ? "Compress it" : `Compress all ${waiting.length}`}
                </Button>
                <span className="text-sm text-muted">Or pick them one by one below.</span>
              </div>
            ) : (
              <p className="mt-3 inline-block rounded-md bg-dlc/10 px-3 py-1.5 text-sm font-semibold text-dlc">
                Finish the setup above to start.
              </p>
            )}
            <ErrorText>{startMany.error?.message}</ErrorText>
            {skipped.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-sm text-danger">
                {skipped.map((item) => (
                  <li key={item.fileId}>
                    {nameOf(item.fileId)} wasn't queued: {item.reason}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
          <CardList className="mt-4">
            {waiting.map((candidate) => (
              <CandidateRow
                key={candidate.file.id}
                candidate={candidate}
                rootPath={rootPaths.get(candidate.file.rootId)}
                ready={ready}
              />
            ))}
          </CardList>
        </>
      )}
    </Card>
  );
}

export function CompressionPage() {
  const settings = useCompressSettings();
  const tasks = useCompressTasks();
  const list = tasks.data ?? [];
  const ready = settings.data?.problem === null;

  return (
    <>
      <PageHeader title="Compression">
        Make NSZ copies of your NSP files. They're usually 30 to 60% smaller and install on the
        Switch the same way. Nothing is kept unless it matches the original exactly.
      </PageHeader>
      {(!ready || list.length === 0) && <HowItWorks />}

      {settings.error && <LoadError error={settings.error} />}
      {settings.data &&
        (ready ? (
          <SettingsSummary settings={settings.data} />
        ) : (
          <SetupSteps settings={settings.data} />
        ))}

      {tasks.error && <LoadError error={tasks.error} />}
      <ActiveSection tasks={list} />
      <FinishedSection tasks={list} />
      {settings.data && (
        <CandidatesSection tasks={list} ready={ready} keysReady={settings.data.keysReady} />
      )}
    </>
  );
}
