/** The NSLibrary mark: a base game, an update, and DLC side by side, as in the favicon. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" className="shrink-0">
      <rect x="3" y="9" width="9" height="14" rx="2" className="fill-ink" />
      <rect x="13.5" y="9" width="7" height="14" rx="1.5" className="fill-update" />
      <rect x="22" y="9" width="7" height="14" rx="1.5" className="fill-dlc" />
    </svg>
  );
}
