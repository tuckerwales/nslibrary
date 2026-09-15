import { type CSSProperties, useState } from "react";

function hueFor(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function initials(name: string): string {
  const words = name.split(/[\s\-–:]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? "")
    .join("")
    .toUpperCase();
}

export function TitleIcon({
  name,
  seed,
  url,
  size = 44,
}: {
  name: string;
  seed: string;
  url: string | null;
  /** Pixels, or "fill" for a square as wide as its container. */
  size?: number | "fill";
}) {
  const fill = size === "fill";
  const box = fill ? undefined : { width: size, height: size };
  const shape = fill ? "aspect-square w-full" : "shrink-0";
  // Remember which URL failed, so a new URL (say, after keys are added) gets its own try.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (url && url !== failedUrl) {
    return (
      <img
        src={url}
        alt=""
        width={fill ? undefined : size}
        height={fill ? undefined : size}
        loading={fill ? "lazy" : undefined}
        className={`${shape} rounded-md object-cover`}
        style={box}
        onError={() => setFailedUrl(url)}
      />
    );
  }
  if (fill) {
    // The initials scale with the tile, which only its own container units can do.
    return (
      <span
        aria-hidden="true"
        className={`title-tile grid ${shape} place-items-center rounded-md font-bold condensed [container-type:inline-size]`}
        style={{ "--hue": hueFor(seed) } as CSSProperties}
      >
        <span className="text-[40cqi] leading-none">{initials(name)}</span>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`title-tile grid ${shape} place-items-center rounded-md font-bold condensed`}
      style={{ ...box, fontSize: Math.round(size * 0.4), "--hue": hueFor(seed) } as CSSProperties}
    >
      {initials(name)}
    </span>
  );
}
