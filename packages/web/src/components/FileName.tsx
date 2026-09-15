import type { LibraryFileInfo } from "@nslib/shared";

/** A library file as its name, with the folder it lives in underneath. */
export function FileName({ file, rootPath }: { file: Pick<LibraryFileInfo, "relPath">; rootPath?: string }) {
  const slash = file.relPath.lastIndexOf("/");
  const name = file.relPath.slice(slash + 1);
  const folder = [rootPath, slash === -1 ? "" : file.relPath.slice(0, slash)].filter(Boolean).join("/");
  return (
    <span className="block min-w-0 [overflow-wrap:anywhere]">
      <span className="block">{name}</span>
      {folder && <span className="block text-sm text-muted">{folder}</span>}
    </span>
  );
}
