import type { AppSummary } from "@nslib/shared";
import { updateLabel } from "../format";

type StripApp = Pick<AppSummary, "hasBase" | "updateVersions" | "addonCount" | "flags">;

const SIZES = {
  sm: "h-6 px-2 text-xs",
  lg: "h-8 px-3 text-sm",
};

/**
 * What a title's library holds, as segments: base game, newest update, DLC. A dashed
 * segment marks a missing base game.
 */
export function ContentStrip({ app, size = "sm" }: { app: StripApp; size?: keyof typeof SIZES }) {
  const segment = `inline-flex items-center rounded-[3px] font-semibold semi-condensed whitespace-nowrap ${SIZES[size]}`;
  const latestUpdate = app.updateVersions[0];
  const hasUnknownUpdate = latestUpdate === undefined && app.flags.includes("unknown-version");

  const description = [
    app.hasBase ? "base game" : "no base game",
    latestUpdate !== undefined ? updateLabel(latestUpdate) : hasUnknownUpdate ? "an update" : null,
    app.addonCount > 0 ? `${app.addonCount} DLC` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      className="flex flex-wrap items-center gap-0.5"
      role="img"
      aria-label={`Has ${description}`}
    >
      {app.hasBase ? (
        <span className={`${segment} bg-ink text-panel`}>Base</span>
      ) : (
        <span className={`${segment} border border-dashed border-muted text-muted`}>No base</span>
      )}
      {latestUpdate !== undefined && (
        <span className={`${segment} bg-update text-panel`}>{updateLabel(latestUpdate)}</span>
      )}
      {hasUnknownUpdate && <span className={`${segment} bg-update text-panel`}>Update</span>}
      {app.addonCount > 0 && (
        <span className={`${segment} bg-dlc text-panel`}>{app.addonCount} DLC</span>
      )}
    </div>
  );
}
