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
  size?: number;
}) {
  const box = { width: size, height: size };
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-md object-cover"
        style={box}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="title-tile grid shrink-0 place-items-center rounded-md font-bold condensed"
      style={{ ...box, fontSize: Math.round(size * 0.4), "--hue": hueFor(seed) } as CSSProperties}
    >
      {initials(name)}
    </span>
  );
}
