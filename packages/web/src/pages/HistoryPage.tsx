import type { JobSource, WebJob } from "@nslib/shared";
import { useState } from "react";
import { Link } from "react-router";
import {
  DEFAULT_JOB_LIMIT,
  useCancelJob,
  useDevices,
  useJobs,
  useReorderJobs,
  useResumeJob,
} from "../api";
import { Badge, Count } from "../components/Badge";
import { Button } from "../components/Button";
import { Card, CardList, cardRow } from "../components/Card";
import { LoadError, Loading } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { ProgressBar } from "../components/ProgressBar";
import { RelativeTime } from "../components/RelativeTime";
import { activeJobs, finishedJobs, jobPercent, jobSpeed, jobStatusLabel, jobTitle } from "../jobs";

const STATUS_TONE = {
  done: "success",
  failed: "danger",
  cancelled: "neutral",
  interrupted: "warning",
} as const;

function sourceLabel(source: JobSource): string {
  return source === "switch" ? "Started on Switch" : "Sent from web";
}

/** One Switch's running and queued installs, with the queue reorderable. */
function DeviceQueue({ name, jobs }: { name: string; jobs: WebJob[] }) {
  const cancel = useCancelJob();
  const reorder = useReorderJobs();
  const queued = jobs.filter((job) => job.status === "queued");

  const move = (job: WebJob, offset: -1 | 1) => {
    const ids = queued.map((j) => j.id);
    const from = ids.indexOf(job.id);
    const to = from + offset;
    if (from === -1 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to] as number, ids[from] as number];
    reorder.mutate({ deviceId: job.deviceId, ids });
  };

  return (
    <div className="mt-2 border-t border-line first:mt-3">
      <h3 className={`${cardRow} pb-0 text-lg semi-condensed`}>{name}</h3>
      <ol className="mt-1 divide-y divide-line">
        {jobs.map((job) => {
          const queueIndex = queued.indexOf(job);
          const title = jobTitle(job);
          return (
            <li
              key={job.id}
              className={`${cardRow} flex flex-wrap items-center justify-between gap-3`}
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold semi-condensed">{title}</p>
                <p className="text-sm text-muted">
                  {sourceLabel(job.source)} · {jobStatusLabel(job)}
                  {jobSpeed(job) && ` · ${jobSpeed(job)}`}
                </p>
                {job.status === "running" && (
                  <ProgressBar
                    className="mt-1.5 max-w-md"
                    percent={jobPercent(job)}
                    label={`Installing ${title}`}
                  />
                )}
              </div>
              <div className="flex gap-1">
                {queued.length > 1 && queueIndex !== -1 && (
                  <>
                    <Button
                      variant="ghost"
                      className="h-8 px-2"
                      aria-label={`Move ${title} earlier in the queue`}
                      disabled={reorder.isPending || queueIndex === 0}
                      onClick={() => move(job, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-8 px-2"
                      aria-label={`Move ${title} later in the queue`}
                      disabled={reorder.isPending || queueIndex === queued.length - 1}
                      onClick={() => move(job, 1)}
                    >
                      ↓
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  className="h-8 px-2"
                  aria-label={`Cancel ${title}`}
                  disabled={cancel.isPending && cancel.variables === job.id}
                  onClick={() => cancel.mutate(job.id)}
                >
                  Cancel
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function HistoryPage() {
  const [limit, setLimit] = useState(DEFAULT_JOB_LIMIT);
  const devices = useDevices();
  const jobs = useJobs(limit);
  const resume = useResumeJob();
  const dismiss = useCancelJob();
  const names = new Map((devices.data ?? []).map((d) => [d.id, d.name]));
  const deviceName = (id: number) => names.get(id) ?? `Switch ${id}`;

  const list = jobs.data ?? [];
  const active = activeJobs(list);
  const allFinished = finishedJobs(list);
  // The server sends one more than asked for, to show whether older jobs exist.
  const finished = allFinished.slice(0, limit);
  const hasOlder = allFinished.length > limit;

  const byDevice = new Map<number, WebJob[]>();
  for (const job of active)
    byDevice.set(job.deviceId, [...(byDevice.get(job.deviceId) ?? []), job]);

  return (
    <>
      <PageHeader title="History">
        <p>Installs queued from the web or started on a Switch, newest first.</p>
      </PageHeader>

      {jobs.error ? (
        <LoadError error={jobs.error} />
      ) : !jobs.data ? (
        <Loading />
      ) : list.length === 0 ? (
        <p className="text-muted">
          No installs yet.{" "}
          <Link to="/devices" className="text-accent hover:underline">
            Pair a Switch
          </Link>{" "}
          and send a title, or start one from the console.
        </p>
      ) : (
        <>
          {active.length > 0 && (
            <Card className="mb-6" title="In progress" count={<Count value={active.length} />}>
              {[...byDevice].map(([deviceId, deviceJobs]) => (
                <DeviceQueue key={deviceId} name={deviceName(deviceId)} jobs={deviceJobs} />
              ))}
            </Card>
          )}

          <Card title="Past installs">
            {finished.length === 0 ? (
              <p className={`${cardRow} pt-1 pb-4 text-muted`}>Nothing has finished yet.</p>
            ) : (
              <CardList>
                {finished.map((job) => (
                  <li key={job.id} className={cardRow}>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="font-semibold semi-condensed">{jobTitle(job)}</p>
                      <Badge
                        tone={
                          job.status in STATUS_TONE
                            ? STATUS_TONE[job.status as keyof typeof STATUS_TONE]
                            : "neutral"
                        }
                      >
                        {jobStatusLabel(job)}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted">
                      {deviceName(job.deviceId)} · {sourceLabel(job.source)}
                      {job.completedAt ? (
                        <>
                          {" "}
                          · <RelativeTime timestamp={job.completedAt} />
                        </>
                      ) : null}
                    </p>
                    {job.error && <p className="mt-1 text-sm text-danger">{job.error}</p>}
                    {job.status === "interrupted" && (
                      <div className="mt-2 flex gap-1">
                        <Button
                          variant="ghost"
                          className="h-8 px-2"
                          disabled={resume.isPending && resume.variables === job.id}
                          onClick={() => resume.mutate(job.id)}
                        >
                          Resume
                        </Button>
                        {/* The Switch is offered an interrupted install again when it reconnects. */}
                        <Button
                          variant="ghost"
                          className="h-8 px-2"
                          aria-label={`Dismiss ${jobTitle(job)}`}
                          disabled={dismiss.isPending && dismiss.variables === job.id}
                          onClick={() => dismiss.mutate(job.id)}
                        >
                          Dismiss
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </CardList>
            )}
            {hasOlder && (
              <Button
                variant="secondary"
                className="mx-4 my-4 md:mx-5"
                disabled={jobs.isFetching}
                onClick={() => setLimit((current) => current + DEFAULT_JOB_LIMIT)}
              >
                {jobs.isFetching ? "Loading…" : "Show older installs"}
              </Button>
            )}
          </Card>
        </>
      )}
    </>
  );
}
