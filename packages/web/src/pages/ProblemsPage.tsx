import type { LibraryFileInfo } from "@nslib/shared";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useProblems, useRootPaths, useRoots, useScanRoot, useStats } from "../api";
import { Badge, Count } from "../components/Badge";
import { Button, ButtonLink } from "../components/Button";
import { Card, CardList, cardRow } from "../components/Card";
import { LoadError, Loading } from "../components/Feedback";
import { FileName } from "../components/FileName";
import { PageHeader } from "../components/PageHeader";
import { RelativeTime } from "../components/RelativeTime";
import { FORMAT_LABEL, formatBytes, updateLabel, VERIFY_LABEL } from "../format";

function Section({
  title,
  description,
  count,
  children,
}: {
  title: string;
  description: ReactNode;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <Card title={title} count={<Count value={count} />} description={description}>
      <CardList>{children}</CardList>
    </Card>
  );
}

/** Scans every included folder, for fixes made on disk (renamed, restored, or deleted files). */
function RescanButton() {
  const roots = useRoots().data ?? [];
  const scan = useScanRoot();
  const enabled = roots.filter((root) => root.enabled);
  const scanning = roots.some((root) => root.scan.state !== "idle");
  if (enabled.length === 0) return null;
  return (
    <Button
      variant="secondary"
      disabled={scanning || scan.isPending}
      onClick={() => {
        for (const root of enabled) scan.mutate(root.id);
      }}
    >
      {scanning ? "Scanning…" : "Scan folders again"}
    </Button>
  );
}

/** A duplicate copy with what's needed to choose which to keep. */
function DuplicateFile({ file, rootPath }: { file: LibraryFileInfo; rootPath?: string }) {
  const verify = VERIFY_LABEL[file.verifyStatus];
  return (
    <li className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <FileName file={file} rootPath={rootPath} />
      <span className="flex shrink-0 items-center gap-3 text-sm text-muted">
        <span className="font-semibold text-ink">{FORMAT_LABEL[file.format]}</span>
        <span>{formatBytes(file.size)}</span>
        <Badge tone={verify.tone}>{verify.text}</Badge>
      </span>
    </li>
  );
}

export function ProblemsPage() {
  const problems = useProblems();
  const rootPaths = useRootPaths();
  const keysConfigured = useStats().data?.keysConfigured ?? true;

  if (problems.error) {
    return (
      <>
        <PageHeader title="Problems" />
        <LoadError error={problems.error} />
      </>
    );
  }
  if (!problems.data) {
    return (
      <>
        <PageHeader title="Problems" />
        <Loading />
      </>
    );
  }
  const { unreadable, unidentified, missing, duplicates } = problems.data;
  const total = unreadable.length + unidentified.length + missing.length + duplicates.length;

  return (
    <>
      <PageHeader
        title="Problems"
        actions={
          total > 0 && (
            <>
              <ButtonLink to="/folders" variant="ghost">
                Manage folders
              </ButtonLink>
              <RescanButton />
            </>
          )
        }
      >
        {total === 0 ? (
          <p>
            Nothing needs attention. Damaged, unidentified, missing, and duplicate files show up
            here.
          </p>
        ) : (
          <p>After fixing files on disk, scan again to update this list.</p>
        )}
      </PageHeader>

      {total === 0 && (
        <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center">
          <p className="text-lg font-semibold text-update">
            <span aria-hidden="true">✓ </span>All clear
          </p>
          <p className="mt-1 text-sm text-muted">
            Every file in your library can be read and placed.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-6">
        <Section
          title="Can't be read"
          description="These files are damaged, incomplete, or aren't the format their extension says. Replace them with a good copy."
          count={unreadable.length}
        >
          {unreadable.map((file) => (
            <li key={file.id} className={cardRow}>
              <FileName file={file} rootPath={rootPaths.get(file.rootId)} />
              <p className="mt-0.5 text-sm text-danger">{file.parseError}</p>
            </li>
          ))}
        </Section>

        <Section
          title="Can't be identified"
          description={
            <>
              Nothing in these files says which game they belong to. Add the title ID to the file
              name, like <span className="semi-condensed">Game [0100ABCDEF012000][v0].nsp</span>
              {!keysConfigured && (
                <>
                  , or add your prod.keys in{" "}
                  <Link to="/settings" className="text-accent hover:underline">
                    Settings
                  </Link>{" "}
                  so the files' contents can be read
                </>
              )}
              .
            </>
          }
          count={unidentified.length}
        >
          {unidentified.map((file) => (
            <li key={file.id} className={cardRow}>
              <FileName file={file} rootPath={rootPaths.get(file.rootId)} />
            </li>
          ))}
        </Section>

        <Section
          title="Duplicates"
          description={
            <>
              The same content is in more than one file. Keeping one copy is enough; a verified,
              compressed copy is usually the best one to keep.
              {duplicates.some(
                (group) =>
                  group.files.some((f) => f.format === "nsp") &&
                  group.files.some((f) => f.format === "nsz"),
              ) && (
                <>
                  {" "}
                  NSP files you compressed can be deleted from the{" "}
                  <Link to="/compression" className="underline">
                    Compression
                  </Link>{" "}
                  page once their NSZ has been checked.
                </>
              )}
            </>
          }
          count={duplicates.length}
        >
          {duplicates.map((group) => (
            <li key={`${group.titleId}:${group.version}`} className={cardRow}>
              <Link
                to={`/apps/${group.applicationId}`}
                state={{ back: "/problems" }}
                className="font-semibold hover:underline"
              >
                {group.name}
              </Link>
              <span className="ml-2 text-sm text-muted">
                {group.titleId}
                {group.version !== null && `, ${updateLabel(group.version)}`}
              </span>
              <ul className="mt-2 space-y-2 border-l-2 border-line pl-3">
                {group.files.map((file) => (
                  <DuplicateFile key={file.id} file={file} rootPath={rootPaths.get(file.rootId)} />
                ))}
              </ul>
            </li>
          ))}
        </Section>

        <Section
          title="Missing"
          description="These files were in your library but aren't on disk anymore. If a drive or network share is disconnected, reconnect it and scan again. Otherwise they're removed from this list after 30 days."
          count={missing.length}
        >
          {missing.map((file) => (
            <li key={file.id} className={cardRow}>
              <FileName file={file} rootPath={rootPaths.get(file.rootId)} />
              {file.missingSince && (
                <p className="mt-0.5 text-sm text-muted">
                  Went missing <RelativeTime timestamp={file.missingSince} />
                </p>
              )}
            </li>
          ))}
        </Section>
      </div>
    </>
  );
}
