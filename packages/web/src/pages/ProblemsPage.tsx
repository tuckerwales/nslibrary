import type { LibraryFileInfo } from "@nslib/shared";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useProblems, useRoots } from "../api";
import { FileName } from "../components/FileName";
import { LoadError, PageHeader } from "../components/PageHeader";
import { updateLabel } from "../format";

function Section({
  title,
  description,
  count,
  children,
}: {
  title: string;
  description: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="mt-10 first:mt-0">
      <h2 className="text-xl">
        {title} <span className="text-muted">({count})</span>
      </h2>
      <p className="mt-1 max-w-[65ch] text-muted">{description}</p>
      <ul className="mt-3 border-t border-line">{children}</ul>
    </section>
  );
}

function FilePath({ file, rootPaths }: { file: LibraryFileInfo; rootPaths: Map<number, string> }) {
  return <FileName file={file} rootPath={rootPaths.get(file.rootId)} />;
}

export function ProblemsPage() {
  const problems = useProblems();
  const rootPaths = new Map((useRoots().data ?? []).map((root) => [root.id, root.path]));

  if (problems.error) {
    return (
      <>
        <PageHeader title="Problems" />
        <LoadError error={problems.error} />
      </>
    );
  }
  if (!problems.data) return <PageHeader title="Problems" />;
  const { unreadable, unidentified, missing, duplicates } = problems.data;
  const total = unreadable.length + unidentified.length + missing.length + duplicates.length;

  return (
    <>
      <PageHeader title="Problems">
        {total === 0 && (
          <p>
            Nothing needs attention. Damaged, unidentified, missing, and duplicate files show up
            here.
          </p>
        )}
      </PageHeader>

      <Section
        title="Can't be read"
        description="These files are damaged, incomplete, or aren't the format their extension says."
        count={unreadable.length}
      >
        {unreadable.map((file) => (
          <li key={file.id} className="border-b border-line py-3">
            <FilePath file={file} rootPaths={rootPaths} />
            <p className="mt-0.5 text-sm text-danger">{file.parseError}</p>
          </li>
        ))}
      </Section>

      <Section
        title="Can't be identified"
        description="Nothing in these files says which game they belong to. Add the title ID to the file name, like Game [0100ABCDEF012000][v0].nsp."
        count={unidentified.length}
      >
        {unidentified.map((file) => (
          <li key={file.id} className="border-b border-line py-3">
            <FilePath file={file} rootPaths={rootPaths} />
          </li>
        ))}
      </Section>

      <Section
        title="Duplicates"
        description="The same content is in more than one file. Keeping one copy is enough."
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
                <li key={file.id}>
                  <FilePath file={file} rootPaths={rootPaths} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </Section>

      <Section
        title="Missing"
        description="These files were in your library but aren't on disk anymore. They're removed from this list after 30 days."
        count={missing.length}
      >
        {missing.map((file) => (
          <li key={file.id} className="border-b border-line py-3">
            <FilePath file={file} rootPaths={rootPaths} />
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
