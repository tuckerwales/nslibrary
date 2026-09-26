import type { ReactNode } from "react";

/** Line icons on a 20px grid, drawn with the current text colour. */
const PATHS = {
  library: (
    <>
      <rect x="3" y="3.5" width="4" height="13" rx="1" />
      <rect x="8.5" y="3.5" width="3.5" height="13" rx="1" />
      <path d="m13.6 4.6 3.1-.8 2 12.2-3.1.8z" />
    </>
  ),
  console: (
    <>
      <rect x="2.5" y="5" width="15" height="10" rx="2.5" />
      <path d="M6.5 5v10M13.5 5v10" />
    </>
  ),
  history: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.5 2" />
    </>
  ),
  homebrew: (
    <>
      <path d="m10 2.8 6.3 3.6v7.2L10 17.2l-6.3-3.6V6.4z" />
      <path d="m3.9 6.5 6.1 3.5 6.1-3.5M10 10v7" />
    </>
  ),
  problems: (
    <>
      <path d="M8.7 3.3a1.5 1.5 0 0 1 2.6 0l6.2 11a1.5 1.5 0 0 1-1.3 2.2H3.8a1.5 1.5 0 0 1-1.3-2.2z" />
      <path d="M10 8v3.5M10 14h.01" />
    </>
  ),
  compress: (
    <>
      <path d="M4 7.5h12M4 12.5h12" />
      <path d="m7.5 2.5 2.5 2.5 2.5-2.5M7.5 17.5l2.5-2.5 2.5 2.5" />
    </>
  ),
  devices: (
    <>
      <path d="M3.5 8a9 9 0 0 1 13 0M6 10.8a5.5 5.5 0 0 1 8 0" />
      <circle cx="10" cy="14" r="1.2" />
    </>
  ),
  folder: (
    <path d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3.6l1.8 2H16a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z" />
  ),
  settings: (
    <>
      <path d="M3 6h7M14 6h3M3 14h3M10 14h7" />
      <circle cx="12" cy="6" r="2" />
      <circle cx="8" cy="14" r="2" />
    </>
  ),
  more: (
    <>
      <circle cx="4.5" cy="10" r="1" />
      <circle cx="10" cy="10" r="1" />
      <circle cx="15.5" cy="10" r="1" />
    </>
  ),
  search: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13 13 4 4" />
    </>
  ),
  close: <path d="m5 5 10 10M15 5 5 15" />,
  back: <path d="M16 10H4m5-5-5 5 5 5" />,
  sun: (
    <>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7 6 6M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3" />
    </>
  ),
  moon: <path d="M16.5 12.2A6.8 6.8 0 0 1 7.8 3.5a6.8 6.8 0 1 0 8.7 8.7z" />,
  monitor: (
    <>
      <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" />
      <path d="M7 17h6M10 13.5V17" />
    </>
  ),
  signout: (
    <>
      <path d="M8 3.5H5A1.5 1.5 0 0 0 3.5 5v10A1.5 1.5 0 0 0 5 16.5h3" />
      <path d="M12.5 6.5 16 10l-3.5 3.5M16 10H8" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {PATHS[name]}
    </svg>
  );
}
