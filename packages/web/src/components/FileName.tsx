import type { LibraryFileInfo } from "@nslib/shared";

/** The last part of a path, so a folder reads as "games" rather than its full path. */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || path;
}

/** Where a file is: its library folder's name and the folders under it, plus the full path. */
export function fileLocation(relPath: string, rootPath?: string) {
  const slash = relPath.lastIndexOf("/");
  const name = relPath.slice(slash + 1);
  const relDir = slash === -1 ? "" : relPath.slice(0, slash);
  const folder = [rootPath ? baseName(rootPath) : "", relDir].filter(Boolean).join("/");
  const fullPath = [rootPath?.replace(/[\\/]+$/, ""), relPath].filter(Boolean).join("/");
  return { name, folder, fullPath };
}

/**
 * A library file as its name, with the folder it lives in underneath. The folder is shown
 * relative to its library folder; hovering shows the full path.
 */
export function FileName({
  file,
  rootPath,
  compact = false,
}: {
  file: Pick<LibraryFileInfo, "relPath">;
  rootPath?: string;
  /** One line: folder and name together. */
  compact?: boolean;
}) {
  const { name, folder, fullPath } = fileLocation(file.relPath, rootPath);
  if (compact) {
    return (
      <span className="block min-w-0 truncate" title={fullPath}>
        {folder && <span className="text-muted">{folder}/</span>}
        {name}
      </span>
    );
  }
  return (
    <span className="block min-w-0 [overflow-wrap:anywhere]" title={fullPath}>
      <span className="block">{name}</span>
      {folder && <span className="block text-sm text-muted">{folder}</span>}
    </span>
  );
}
