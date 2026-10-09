import { type AppFilters, AppFiltersSchema, type AppSummary } from "@nslib/shared";
import { useMemo } from "react";
import { firmwareLabel, formatBytes } from "../format";
import { Select } from "./Select";

/** The filters this panel sets, kept in the URL under the same names the API uses. */
export const MORE_FILTER_KEYS = [
  "publisher",
  "language",
  "region",
  "minPlayers",
  "maxRating",
  "minSize",
  "maxSize",
  "releasedFrom",
  "releasedTo",
  "updatedFrom",
  "updatedTo",
  "maxFirmware",
] as const satisfies readonly (keyof AppFilters)[];

export type MoreFilterKey = (typeof MORE_FILTER_KEYS)[number];
export type MoreFilters = Pick<AppFilters, MoreFilterKey>;

/** The panel's filters from the URL. A value the API would reject is left out. */
export function readMoreFilters(params: URLSearchParams): MoreFilters {
  const filters: Record<string, unknown> = {};
  for (const key of MORE_FILTER_KEYS) {
    const raw = params.get(key);
    if (raw === null || raw === "") continue;
    const parsed = AppFiltersSchema.shape[key].safeParse(raw);
    if (parsed.success && parsed.data !== undefined) filters[key] = parsed.data;
  }
  return filters as MoreFilters;
}

/** How many of the panel's filters are in use; a range counts once. */
export function countMoreFilters(filters: MoreFilters): number {
  const set = (...keys: MoreFilterKey[]) => keys.some((key) => filters[key] !== undefined);
  return [
    set("publisher"),
    set("language"),
    set("region"),
    set("minPlayers"),
    set("maxRating"),
    set("minSize", "maxSize"),
    set("releasedFrom", "releasedTo"),
    set("updatedFrom", "updatedTo"),
    set("maxFirmware"),
  ].filter(Boolean).length;
}

const GB = 1024 ** 3;
const SIZE_PRESETS: { label: string; min?: number; max?: number }[] = [
  { label: "Under 1 GB", max: GB },
  { label: "1 to 4 GB", min: GB, max: 4 * GB },
  { label: "4 to 16 GB", min: 4 * GB, max: 16 * GB },
  { label: "Over 16 GB", min: 16 * GB },
];
const sizeValue = (min?: number, max?: number) =>
  min === undefined && max === undefined ? "" : `${min ?? ""}-${max ?? ""}`;

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function displayName(type: "language" | "region", code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type }).of(code) ?? code;
  } catch {
    // Not a code Intl knows, like a titledb-specific region.
    return code;
  }
}

interface Option {
  value: string;
  label: string;
}

const yearOf = (date: number) => Math.floor(date / 10000);

/** What the library holds for each filter, so the panel only offers choices that match something. */
function libraryOptions(apps: AppSummary[]) {
  const publishers = new Map<string, string>();
  const languages = new Set<string>();
  const regions = new Set<string>();
  const ratings = new Set<number>();
  const releaseYears = new Set<number>();
  const updateYears = new Set<number>();
  const firmware = new Set<number>();
  let maxPlayers = 0;
  for (const app of apps) {
    const publisherKey = app.publisher?.toLowerCase();
    if (app.publisher && publisherKey && !publishers.has(publisherKey)) {
      publishers.set(publisherKey, app.publisher);
    }
    for (const code of app.languages) languages.add(code);
    for (const code of app.regions) regions.add(code);
    if (app.rating !== null) ratings.add(app.rating);
    if (app.players !== null) maxPlayers = Math.max(maxPlayers, app.players);
    if (app.releaseDate !== null) releaseYears.add(yearOf(app.releaseDate));
    if (app.lastUpdateDate !== null) updateYears.add(yearOf(app.lastUpdateDate));
    if (app.requiredSystemVersion !== null) firmware.add(app.requiredSystemVersion);
  }
  const named = (codes: Set<string>, type: "language" | "region"): Option[] =>
    [...codes]
      .map((code) => ({ value: code, label: displayName(type, code) }))
      .sort((a, b) => collator.compare(a.label, b.label));
  const years = (set: Set<number>): Option[] =>
    [...set].sort((a, b) => b - a).map((year) => ({ value: String(year), label: String(year) }));
  return {
    publishers: [...publishers.values()]
      .sort(collator.compare)
      .map((name) => ({ value: name, label: name })),
    languages: named(languages, "language"),
    regions: named(regions, "region"),
    players: Array.from({ length: Math.max(0, maxPlayers - 1) }, (_, i) => ({
      value: String(i + 2),
      label: `${i + 2} or more`,
    })),
    ratings: [...ratings]
      .sort((a, b) => a - b)
      .map((rating) => ({ value: String(rating), label: `${rating} or under` })),
    releaseYears: years(releaseYears),
    updateYears: years(updateYears),
    firmware: [...firmware]
      .sort((a, b) => b - a)
      .map((version) => ({ value: String(version), label: `${firmwareLabel(version)} or older` })),
  };
}

/**
 * A select with "Any" first. A value from the URL that nothing in the library has still shows, so
 * it can be seen and cleared; a filter with nothing to offer is hidden.
 */
function FilterSelect({
  label,
  value,
  options,
  fallback,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  fallback?: (value: string) => string;
  onChange: (value: string) => void;
}) {
  if (options.length === 0 && !value) return null;
  const shown =
    value && !options.some((option) => option.value === value)
      ? [{ value, label: fallback?.(value) ?? value }, ...options]
      : options;
  return (
    <Select label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Any</option>
      {shown.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}

const numberOrUndefined = (value: string) => (value === "" ? undefined : Number(value));

/** Filters by what titledb and the files say about each game, offered from what's in the library. */
export function LibraryFilters({
  apps,
  filters,
  onChange,
}: {
  /** The whole library, for the choices. */
  apps: AppSummary[];
  filters: MoreFilters;
  onChange: (patch: MoreFilters) => void;
}) {
  const options = useMemo(() => libraryOptions(apps), [apps]);
  const text = (value: string | number | undefined) => (value === undefined ? "" : String(value));
  const year = (date: number | undefined) => (date === undefined ? "" : String(yearOf(date)));
  const fromYear = (value: string) => (value === "" ? undefined : Number(value) * 10000 + 101);
  const toYear = (value: string) => (value === "" ? undefined : Number(value) * 10000 + 1231);

  const size = sizeValue(filters.minSize, filters.maxSize);
  const sizeOptions = SIZE_PRESETS.map((preset) => ({
    value: sizeValue(preset.min, preset.max),
    label: preset.label,
  }));

  return (
    <fieldset
      id="library-filters"
      className="grid grid-cols-2 gap-x-3 gap-y-3 rounded-lg border border-line p-3 sm:gap-x-4 sm:p-4 lg:grid-cols-4"
    >
      <legend className="sr-only">More filters</legend>
      <FilterSelect
        label="Publisher"
        value={text(filters.publisher)}
        options={options.publishers}
        onChange={(value) => onChange({ publisher: value || undefined })}
      />
      <FilterSelect
        label="Language"
        value={text(filters.language)}
        options={options.languages}
        fallback={(code) => displayName("language", code)}
        onChange={(value) => onChange({ language: value || undefined })}
      />
      <FilterSelect
        label="Region"
        value={text(filters.region)}
        options={options.regions}
        fallback={(code) => displayName("region", code)}
        onChange={(value) => onChange({ region: value || undefined })}
      />
      <FilterSelect
        label="Players"
        value={text(filters.minPlayers)}
        options={options.players}
        fallback={(value) => `${value} or more`}
        onChange={(value) => onChange({ minPlayers: numberOrUndefined(value) })}
      />
      <FilterSelect
        label="Age rating"
        value={text(filters.maxRating)}
        options={options.ratings}
        fallback={(value) => `${value} or under`}
        onChange={(value) => onChange({ maxRating: numberOrUndefined(value) })}
      />
      <FilterSelect
        label="Size"
        value={size}
        options={sizeOptions}
        fallback={() =>
          `${filters.minSize === undefined ? "Any" : formatBytes(filters.minSize)} to ${
            filters.maxSize === undefined ? "any" : formatBytes(filters.maxSize)
          }`
        }
        onChange={(value) => {
          const [min = "", max = ""] = value.split("-");
          onChange({ minSize: numberOrUndefined(min), maxSize: numberOrUndefined(max) });
        }}
      />
      <FilterSelect
        label="Needs firmware"
        value={text(filters.maxFirmware)}
        options={options.firmware}
        fallback={(value) => `${firmwareLabel(Number(value))} or older`}
        onChange={(value) => onChange({ maxFirmware: numberOrUndefined(value) })}
      />
      <FilterSelect
        label="Released from"
        value={year(filters.releasedFrom)}
        options={options.releaseYears}
        onChange={(value) => onChange({ releasedFrom: fromYear(value) })}
      />
      <FilterSelect
        label="Released until"
        value={year(filters.releasedTo)}
        options={options.releaseYears}
        onChange={(value) => onChange({ releasedTo: toYear(value) })}
      />
      <FilterSelect
        label="Last updated from"
        value={year(filters.updatedFrom)}
        options={options.updateYears}
        onChange={(value) => onChange({ updatedFrom: fromYear(value) })}
      />
      <FilterSelect
        label="Last updated until"
        value={year(filters.updatedTo)}
        options={options.updateYears}
        onChange={(value) => onChange({ updatedTo: toYear(value) })}
      />
    </fieldset>
  );
}
