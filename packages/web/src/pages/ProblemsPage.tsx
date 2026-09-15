import type { LibraryFileInfo } from "@nslib/shared";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useProblems, useRootPaths, useRoots, useScanRoot, useStats } from "../api";
import { Button, ButtonLink } from "../components/Button";
import { LoadError, Loading } from "../components/Feedback";
import { FileName } from "../components/FileName";
import { PageHeader } from "../components/PageHeader";
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
    <section className="mt-10 first:mt-0">
      <h2 className="text-xl">
        {title} <span className="text-muted">({count})</span>
      </h2>
      <div className="mt-1 max-w-[65ch] text-muted">{description}</div>
      <ul className="mt-3 border-t border-line">{children}</ul>
    </section>
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
    <li className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <FileName file={file} rootPath={rootPath} />
      <span className="flex shrink-0 gap-3 text-sm text-muted">
        <span>{FORMAT_LABEL[file.format]}</span>
        <span>{formatBytes(file.size)}</span>
        <span className={verify.className}>{verify.text}</span>
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
      <PageHeader title="Problems">
        {total === 0 ? (
          <p>
            Nothing needs attention. Damaged, unidentified, missing, and duplicate files show up
            here.
          </p>
        ) : (
          <p>After fixing files on disk, scan again to update this list.</p>
        )}
      </PageHeader>

      {total > 0 && (
        <div className="-mt-2 mb-8 flex flex-wrap gap-2">
          <RescanButton />
          <ButtonLink to="/folders" variant="ghost">
            Manage folders
          </ButtonLink>
        </div>
      )}

      <Section
        title="Can't be read"
        description="These files are damaged, incomplete, or aren't the format their extension says. Replace them with a good copy."
        count={unreadable.length}
      >
        {unreadable.map((file) => (
          <li key={file.id} className="border-b border-line py-3">
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
          <li key={file.id} className="border-b border-line py-3">
            <FileName file={file} rootPath={rootPaths.get(file.rootId)} />
          </li>
        ))}
      </Section>

      <Section
        title="Duplicates"
        description="The same content is in more than one file. Keeping one copy is enough; a verified, compressed copy is usually the best one to keep."
        count={duplicates.length}
      >
        {duplicates.map((group) => (
          <li key={`${group.titleId}:${group.version}`} className="border-b border-line py-3">
            <Link to={`/apps/${group.applicationId}`} className="font-semibold hover:underline">
              {group.name}
            </Link>
            <span className="ml-2 text-sm text-muted">
              {group.titleId}
              {group.version !== null && `, ${updateLabel(group.version)}`}
            </span>
            <ul className="mt-2 space-y-2">
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
          <li key={file.id} className="border-b border-line py-3">
            <FileName file={file} rootPath={rootPaths.get(file.rootId)} />
            {file.missingSince && (
              <p className="mt-0.5 text-sm text-muted">
                Missing since {new Date(file.missingSince).toLocaleString()}
              </p>
            )}
          </li>
        ))}
      </Section>
    </>
  );
}
