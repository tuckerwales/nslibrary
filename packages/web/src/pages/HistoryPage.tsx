import type { JobSource, WebJob } from "@nslib/shared";
import { Link } from "react-router";
import { useCancelJob, useDevices, useJobs } from "../api";
import { Button } from "../components/Button";
import { LoadError, PageHeader } from "../components/PageHeader";
import { formatBytes, relativeTime, updateLabel } from "../format";

function jobTitle(job: WebJob): string {
  if (job.type === "patch") return `${job.name} · ${updateLabel(job.version)}`;
  return job.name;
}

function sourceLabel(source: JobSource): string {
  return source === "switch" ? "Started on Switch" : "Sent from web";
}

function statusLabel(job: WebJob): string {
  if (job.status === "running" && job.size > 0) {
    return `running · ${formatBytes(job.bytesDone)} of ${formatBytes(job.size)}`;
  }
  return job.status;
}

export function HistoryPage() {
  const devices = useDevices();
  const jobs = useJobs();
  const cancel = useCancelJob();
  const names = new Map((devices.data ?? []).map((d) => [d.id, d.name]));
  const list = [...(jobs.data ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const active = list.filter(
    (job) => job.status === "queued" || job.status === "claimed" || job.status === "running",
  );
  const finished = list.filter(
    (job) =>
      job.status === "done" ||
      job.status === "failed" ||
      job.status === "cancelled" ||
      job.status === "interrupted",
  );

  return (
    <>
      <PageHeader title="History">
        <p>Installs queued from the web or started on a Switch, newest first.</p>
      </PageHeader>

      {jobs.error ? (
        <LoadError error={jobs.error} />
      ) : !jobs.data ? null : list.length === 0 ? (
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
              <ul className="mt-3 border-t border-line">
                {active.map((job) => (
                  <li
                    key={job.id}
                    className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line py-3"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold semi-condensed">{jobTitle(job)}</p>
                      <p className="text-sm text-muted">
                        {names.get(job.deviceId) ?? `Switch ${job.deviceId}`} ·{" "}
                        {sourceLabel(job.source)} · {statusLabel(job)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      className="h-8 px-2"
                      onClick={() => cancel.mutate(job.id)}
                    >
                      Cancel
                    </Button>
                  </li>
                ))}
              </ul>
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
                      {names.get(job.deviceId) ?? `Switch ${job.deviceId}`} ·{" "}
                      {sourceLabel(job.source)} · {job.status}
                      {job.completedAt ? ` · ${relativeTime(job.completedAt)}` : ""}
                    </p>
                    {job.error && <p className="mt-1 text-sm text-danger">{job.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
