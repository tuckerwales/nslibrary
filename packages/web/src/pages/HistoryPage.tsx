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
import { Button } from "../components/Button";
import { LoadError, Loading } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { activeJobs, finishedJobs, jobStatusLabel, jobTitle } from "../jobs";

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
    <div className="mt-4 first:mt-3">
      <h3 className="text-lg semi-condensed">{name}</h3>
      <ol className="mt-1 border-t border-line">
        {jobs.map((job) => {
          const queueIndex = queued.indexOf(job);
          const title = jobTitle(job);
          return (
            <li
              key={job.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3"
            >
              <div className="min-w-0">
                <p className="font-semibold semi-condensed">{title}</p>
                <p className="text-sm text-muted">
                  {sourceLabel(job.source)} · {jobStatusLabel(job)}
                </p>
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
            <section>
              <h2 className="text-xl">In progress</h2>
              {[...byDevice].map(([deviceId, deviceJobs]) => (
                <DeviceQueue key={deviceId} name={deviceName(deviceId)} jobs={deviceJobs} />
              ))}
            </section>
          )}

          <section className={active.length > 0 ? "mt-10" : undefined}>
            <h2 className="text-xl">Past installs</h2>
            {finished.length === 0 ? (
              <p className="mt-3 text-muted">Nothing has finished yet.</p>
            ) : (
              <ul className="mt-3 border-t border-line">
                {finished.map((job) => (
                  <li key={job.id} className="border-b border-line py-3">
                    <p className="font-semibold semi-condensed">{jobTitle(job)}</p>
                    <p className="text-sm text-muted">
                      {deviceName(job.deviceId)} · {sourceLabel(job.source)} · {jobStatusLabel(job)}
                      {job.completedAt ? (
                        <>
                          {" "}
                          · <RelativeTime timestamp={job.completedAt} />
                        </>
                      ) : null}
                    </p>
                    {job.error && <p className="mt-1 text-sm text-danger">{job.error}</p>}
                    {job.status === "interrupted" && (
                      <Button
                        variant="ghost"
                        className="mt-2 h-8 px-2"
                        disabled={resume.isPending && resume.variables === job.id}
                        onClick={() => resume.mutate(job.id)}
                      >
                        Resume
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {hasOlder && (
              <Button
                variant="secondary"
                className="mt-4"
                disabled={jobs.isFetching}
                onClick={() => setLimit((current) => current + DEFAULT_JOB_LIMIT)}
              >
                {jobs.isFetching ? "Loading…" : "Show older installs"}
              </Button>
            )}
          </section>
        </>
      )}
    </>
  );
}
