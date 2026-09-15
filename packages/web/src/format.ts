import type { ContainerFormat, MetadataSource, VerifyStatus } from "@nslib/shared";
import { useEffect } from "react";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Update versions step by 65536; v196608 is the third update. */
export function updateLabel(version: number): string {
  return version > 0 && version % 65536 === 0 ? `Update ${version / 65536}` : `v${version}`;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  return new Date(timestamp).toLocaleDateString();
}

export const FORMAT_LABEL: Record<ContainerFormat, string> = {
  nsp: "NSP",
  nsz: "NSZ",
  xci: "XCI",
  xcz: "XCZ",
  nro: "NRO",
};

export const SOURCE_LABEL: Record<MetadataSource, string> = {
  filename: "From file name",
  ticket: "From ticket",
  cnmt: "From content metadata",
  nacp: "From app info",
};

/** How a file's integrity check result reads, and its text colour. */
export const VERIFY_LABEL: Record<VerifyStatus, { text: string; className: string }> = {
  unverified: { text: "Not verified", className: "text-muted" },
  ok: { text: "Verified", className: "text-update" },
  partial: { text: "Partly verified", className: "text-dlc" },
  bad: { text: "Damaged", className: "text-danger" },
};

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

export function usePageTitle(title: string | undefined) {
  useEffect(() => {
    document.title = title ? `${title} – NSLibrary` : "NSLibrary";
  }, [title]);
}
