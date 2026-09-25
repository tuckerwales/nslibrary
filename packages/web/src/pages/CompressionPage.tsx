import type { CompressCandidate, CompressTask } from "@nslib/shared";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import {
  isCompressActive,
  useCancelCompress,
  useCompressCandidates,
  useCompressSettings,
  useCompressTasks,
  usePutCompressSettings,
  useRootPaths,
  useStartCompress,
  useStartCompressMany,
} from "../api";
import { Button } from "../components/Button";
import { ErrorText, LoadError, Loading } from "../components/Feedback";
import { inputClass, Switch } from "../components/Field";
import { FileName } from "../components/FileName";
import { PageHeader } from "../components/PageHeader";
import { Select } from "../components/Select";
import {
  COMPRESS_LEVELS,
  compressProgressText,
  outputFileName,
  savedText,
  totalSaved,
} from "../compress";
import { formatBytes, plural, updateLabel } from "../format";

function SettingsSection() {
  const settings = useCompressSettings();
  const put = usePutCompressSettings();
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const folder = outputDir ?? settings.data?.outputDir ?? "";

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    put.mutate({ outputDir: folder.trim() || null }, { onSuccess: () => setOutputDir(null) });
  };

  if (settings.error) return <LoadError error={settings.error} />;
  if (!settings.data) return <Loading />;
  const { level, removeOriginal, problem, outputInLibrary } = settings.data;
  const levelHint = COMPRESS_LEVELS.find((option) => option.level === level)?.hint;

  return (
    <section className="max-w-2xl">
      <h2 className="text-xl">Settings</h2>
      <form onSubmit={onSubmit} className="mt-3">
        <label htmlFor="compress-output" className="block text-sm font-semibold">
          Output folder
        </label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <input
            id="compress-output"
            className={inputClass}
            placeholder="/library/compressed"
            aria-describedby="compress-output-hint"
            value={folder}
            onChange={(event) => {
              setOutputDir(event.target.value);
              put.reset();
            }}
          />
          <Button type="submit" disabled={put.isPending}>
            {put.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        <p id="compress-output-hint" className="mt-1 text-sm text-muted">
          A folder on the server the NSZ files are written to. Put it inside a library folder so
          they're listed and sent to the Switch.
        </p>
        <ErrorText>{put.error?.message}</ErrorText>
      </form>
      {problem ? (
        <p className="mt-3 text-sm text-danger">
          {problem}
          {problem.includes("prod.keys") && (
            <>
              {" "}
              <Link to="/settings" className="underline">
                Settings
              </Link>
            </>
          )}
        </p>
      ) : (
        !outputInLibrary && (
          <p className="mt-3 text-sm text-dlc">
            This folder isn't in your library, so new NSZ files won't be listed. Add it (or a folder
            that contains it) on the{" "}
            <Link to="/folders" className="underline">
              Folders
            </Link>{" "}
            page.
          </p>
        )
      )}

      <div className="mt-5 max-w-xs">
        <Select
          label="Compression level"
          value={COMPRESS_LEVELS.some((option) => option.level === level) ? level : ""}
          disabled={put.isPending}
          onChange={(event) => put.mutate({ level: Number(event.target.value) })}
        >
          {!COMPRESS_LEVELS.some((option) => option.level === level) && (
            <option value="">Level {level}</option>
          )}
          {COMPRESS_LEVELS.map((option) => (
            <option key={option.level} value={option.level}>
              {option.label} (level {option.level})
            </option>
          ))}
        </Select>
        {levelHint && <p className="mt-1 text-sm text-muted">{levelHint}</p>}
      </div>
      <div className="mt-5">
        <Switch
          label="Remove the original NSP"
          hint="Deleted only after its NSZ has been read back and matches it exactly. Folders mounted read-only keep their files."
          checked={removeOriginal}
          disabled={put.isPending}
          onChange={(value) => put.mutate({ removeOriginal: value })}
        />
      </div>
    </section>
  );
}

function TaskRow({ task }: { task: CompressTask }) {
  const cancel = useCancelCompress();
  const active = isCompressActive(task);
  const result = task.result;
  const percent =
    active && task.state === "running" && task.bytesTotal > 0
      ? Math.floor((task.bytesDone / task.bytesTotal) * 100)
      : null;

  return (
    <li className="border-b border-line py-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
        <FileName file={task} />
        <span className="flex shrink-0 items-baseline gap-3 text-sm">
          {active ? (
            <>
              <span className="text-muted" aria-live="polite">
                {compressProgressText(task)}
              </span>
              <Button
                variant="ghost"
                className="h-8 px-2"
                disabled={cancel.isPending}
                aria-label={`Stop compressing: ${task.relPath}`}
                onClick={() => cancel.mutate(task.fileId)}
              >
                Stop
              </Button>
            </>
          ) : task.state === "done" && result ? (
            <span className="text-update">{savedText(result)}</span>
          ) : task.state === "failed" ? (
            <span className="text-danger">Failed</span>
          ) : (
            <span className="text-muted">Cancelled</span>
          )}
        </span>
      </div>
      {percent !== null && (
        <div
          className="mt-2 h-1 overflow-hidden rounded-full bg-line"
          role="progressbar"
          aria-label={`${task.relPath}: ${compressProgressText(task)}`}
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
        </div>
      )}
      {task.state === "failed" && (
        <p className="mt-1 text-sm text-danger [overflow-wrap:anywhere]">{task.error}</p>
      )}
      {result && (
        <div className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">
          <p>
            {formatBytes(result.sourceSize)} to {formatBytes(result.outputSize)} as{" "}
            {outputFileName(result.outputPath)}.
            {result.originalRemoved ? " The NSP was removed." : ""}
            {result.inLibrary ? "" : " Not in a library folder, so it isn't listed."}
          </p>
          {[...result.warnings, ...result.items.flatMap((item) => (item.note ? [item.note] : []))]
            .length > 0 && (
            <ul className="mt-0.5 space-y-0.5 text-dlc">
              {result.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
              {result.items
                .filter((item) => item.note)
                .map((item) => (
                  <li key={item.name}>
                    {item.name}: {item.note}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
      <ErrorText>{cancel.error?.message}</ErrorText>
    </li>
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
  task,
}: {
  candidate: CompressCandidate;
  rootPath: string | undefined;
  task: CompressTask | undefined;
}) {
  const start = useStartCompress();
  return (
    <li className="border-b border-line py-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <p className="font-semibold [overflow-wrap:anywhere]">{candidateLabel(candidate)}</p>
          <div className="text-sm">
            <FileName file={candidate.file} rootPath={rootPath} />
          </div>
        </div>
        <span className="flex shrink-0 items-baseline gap-3 text-sm">
          <span className="text-muted">{formatBytes(candidate.file.size)}</span>
          {task && isCompressActive(task) ? (
            <span className="text-muted">{compressProgressText(task)}</span>
          ) : (
            <Button
              variant="ghost"
              className="h-8 px-2"
              disabled={start.isPending}
              aria-label={`Compress to NSZ: ${candidate.file.relPath}`}
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

function CandidatesSection({ tasks }: { tasks: CompressTask[] }) {
  const candidates = useCompressCandidates();
  const rootPaths = useRootPaths();
  const startMany = useStartCompressMany();
  const taskByFile = new Map(tasks.map((task) => [task.fileId, task]));

  if (candidates.error) return <LoadError error={candidates.error} />;
  if (!candidates.data) return <Loading />;
  const waiting = candidates.data.filter(
    (candidate) => !isCompressActive(taskByFile.get(candidate.file.id)),
  );
  const size = waiting.reduce((sum, candidate) => sum + candidate.file.size, 0);
  const skipped = startMany.data?.skipped ?? [];

  return (
    <section className="mt-12">
      <h2 className="text-xl">
        Not compressed yet <span className="text-muted">({candidates.data.length})</span>
      </h2>
      <p className="mt-1 max-w-[65ch] text-muted">
        NSP files with no NSZ copy in the library. Files NSLibrary hasn't read the content list of
        (it needs prod.keys) aren't shown, since their NSZ couldn't be checked.
      </p>
      {candidates.data.length === 0 ? (
        <p className="mt-3 text-muted">Everything that can be compressed has been.</p>
      ) : (
        <>
          {waiting.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                disabled={startMany.isPending}
                onClick={() => startMany.mutate(waiting.map((candidate) => candidate.file.id))}
              >
                Compress all ({waiting.length})
              </Button>
              <span className="text-sm text-muted">
                {plural(waiting.length, "file")}, {formatBytes(size)}. They run one at a time.
              </span>
            </div>
          )}
          <ErrorText>{startMany.error?.message}</ErrorText>
          {skipped.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-sm text-danger">
              {skipped.map((item) => (
                <li key={item.fileId}>
                  {candidates.data.find((c) => c.file.id === item.fileId)?.file.relPath ??
                    `File ${item.fileId}`}
                  : {item.reason}
                </li>
              ))}
            </ul>
          )}
          <ul className="mt-4 border-t border-line">
            {candidates.data.map((candidate) => (
              <CandidateRow
                key={candidate.file.id}
                candidate={candidate}
                rootPath={rootPaths.get(candidate.file.rootId)}
                task={taskByFile.get(candidate.file.id)}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function CompressionPage() {
  const tasks = useCompressTasks();
  const list = tasks.data ?? [];
  const saved = totalSaved(list);

  return (
    <>
      <PageHeader title="Compression">
        Compress NSP files to NSZ on the server, usually 30 to 60% smaller. Each NSZ is read back
        and checked against the title's content metadata before it's kept. With{" "}
        <Link to="/settings" className="underline">
          Prefer NSZ
        </Link>{" "}
        on, the Switch installs the compressed copy.
      </PageHeader>

      <SettingsSection />

      {tasks.error && <LoadError error={tasks.error} />}
      {list.length > 0 && (
        <section className="mt-12">
          <h2 className="text-xl">Queue and results</h2>
          {saved.files > 0 && (
            <p className="mt-1 text-muted">
              Saved {formatBytes(saved.bytes)} across {plural(saved.files, "file")} since the server
              started.
            </p>
          )}
          <ul className="mt-3 border-t border-line">
            {list.map((task) => (
              <TaskRow key={task.fileId} task={task} />
            ))}
          </ul>
        </section>
      )}

      <CandidatesSection tasks={list} />
    </>
  );
}
