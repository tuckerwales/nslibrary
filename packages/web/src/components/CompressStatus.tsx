import type { CompressTask } from "@nslib/shared";
import { useState } from "react";
import { Link } from "react-router";
import { isCompressActive, useCancelCompress, useRemoveOriginal, useStartCompress } from "../api";
import {
  outputFileName,
  outputFolder,
  savedText,
  stepLabel,
  stepPercent,
  timeLeftText,
} from "../compress";
import { formatBytes } from "../format";
import { Button } from "./Button";
import { ConfirmPanel } from "./ConfirmPanel";
import { ErrorText } from "./Feedback";

/** Step, progress bar, and time left for a queued or running compression. */
export function CompressProgress({
  task,
  compact = false,
}: {
  task: CompressTask;
  compact?: boolean;
}) {
  const cancel = useCancelCompress();
  const percent = stepPercent(task);
  const timeLeft = timeLeftText(task);
  const label = `${stepLabel(task)}${percent === null ? "" : `, ${percent}%`}`;

  return (
    <div className={compact ? "mt-1" : "mt-2"}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm" aria-live="polite">
          {label}
        </p>
        <Button
          variant="ghost"
          className="-mr-2 h-8 px-2"
          disabled={cancel.isPending}
          aria-label={`${task.state === "queued" ? "Remove from queue" : "Stop compressing"}: ${task.name}`}
          onClick={() => cancel.mutate(task.fileId)}
        >
          {task.state === "queued" ? "Remove from queue" : "Stop"}
        </Button>
      </div>
      {task.state === "running" && (
        <div
          className="mt-1.5 h-1.5 max-w-xl overflow-hidden rounded-full bg-line"
          role="progressbar"
          aria-label={`${task.name}: ${stepLabel(task)}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
        >
          {percent === null ? (
            <div className="scan-sweep h-full w-2/5 rounded-full bg-accent" />
          ) : (
            <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
          )}
        </div>
      )}
      {!compact && (
        <p className="mt-1 text-sm text-muted">
          {task.state === "queued"
            ? "Compressions run one at a time. This one starts when the one before it finishes."
            : (timeLeft ?? "Working out how long this will take…")}
        </p>
      )}
      <ErrorText>{cancel.error?.message}</ErrorText>
    </div>
  );
}

/** Deletes the NSP a checked NSZ was made from, after asking. */
function DeleteOriginal({ task }: { task: CompressTask }) {
  const remove = useRemoveOriginal();
  const [confirming, setConfirming] = useState(false);
  const result = task.result;
  if (!result) return null;
  return (
    <>
      <Button
        variant="secondary"
        className="mt-2"
        onClick={() => setConfirming(true)}
        aria-expanded={confirming}
      >
        Delete the NSP
      </Button>
      {confirming && (
        <ConfirmPanel
          label="Delete the NSP"
          confirmLabel={remove.isPending ? "Deleting…" : "Delete the NSP"}
          busy={remove.isPending}
          onConfirm={() => remove.mutate(task.fileId, { onSettled: () => setConfirming(false) })}
          onCancel={() => setConfirming(false)}
        >
          <p className="[overflow-wrap:anywhere]">
            Delete {outputFileName(task.relPath)} from disk? Its NSZ was checked and restores to
            exactly the same data, so nothing is lost. This frees {formatBytes(result.sourceSize)}.
          </p>
        </ConfirmPanel>
      )}
      <ErrorText>{remove.error?.message}</ErrorText>
    </>
  );
}

/** What happened to a finished compression and what to do next. */
export function CompressOutcome({ task }: { task: CompressTask }) {
  const retry = useStartCompress();
  const result = task.result;

  if (task.state === "failed" || task.state === "cancelled") {
    const failed = task.state === "failed";
    const needsSetup =
      failed &&
      Boolean(task.error?.match(/prod\.keys|save NSZ files|can't write|Folder not found/));
    return (
      <div className="mt-1 text-sm">
        <p className={failed ? "text-danger [overflow-wrap:anywhere]" : "text-muted"}>
          {failed ? task.error : "Stopped before it finished. Nothing was saved."}
        </p>
        {needsSetup ? (
          <Link to="/compression" className="mt-1 inline-block underline">
            Check the compression setup
          </Link>
        ) : (
          <Button
            variant="secondary"
            className="mt-2"
            disabled={retry.isPending}
            onClick={() => retry.mutate(task.fileId)}
          >
            {failed ? "Try again" : "Start again"}
          </Button>
        )}
        <ErrorText>{retry.error?.message}</ErrorText>
      </div>
    );
  }
  if (!result) return null;

  const notes = [
    ...result.warnings,
    ...result.items.flatMap((item) => (item.note ? [`${item.name}: ${item.note}`] : [])),
  ];
  return (
    <div className="mt-1 text-sm [overflow-wrap:anywhere]">
      <p>
        {formatBytes(result.sourceSize)} NSP → {formatBytes(result.outputSize)} NSZ, checked against
        the original.
      </p>
      {result.inLibrary ? (
        <p className="text-muted">
          The NSZ is in your library{result.originalRemoved ? "" : " next to the NSP"}. With Prefer
          NSZ on, the Switch installs it.
        </p>
      ) : (
        <p className="text-dlc">
          Saved to {outputFolder(result.outputPath)}, which isn't a library folder, so it isn't
          listed yet. Add that folder on the{" "}
          <Link to="/folders" className="underline">
            Folders
          </Link>{" "}
          page to install it.
        </p>
      )}
      {result.originalRemoved ? (
        <p className="text-muted">The NSP was deleted.</p>
      ) : (
        <>
          <p className="text-muted">
            Both copies are on disk for now. Delete the NSP to free the space.
          </p>
          <DeleteOriginal task={task} />
        </>
      )}
      {notes.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-muted">
            {notes.length === 1 ? "1 note" : `${notes.length} notes`}
          </summary>
          <ul className="mt-1 space-y-0.5 text-dlc">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** A finished task's headline: the space saved, or what went wrong. */
export function CompressHeadline({ task }: { task: CompressTask }) {
  if (isCompressActive(task)) return null;
  if (task.state === "done" && task.result) {
    return (
      <span className="font-semibold text-update">
        <span aria-hidden="true">✓ </span>
        {savedText(task.result)}
      </span>
    );
  }
  if (task.state === "failed") {
    return <span className="font-semibold text-danger">Couldn't compress</span>;
  }
  return <span className="text-muted">Stopped</span>;
}
