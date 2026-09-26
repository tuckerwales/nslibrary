import { setTheme, type Theme, useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";

const OPTIONS: { value: Theme; label: string; icon: IconName }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

/** Light, dark, or whatever the system uses. */
export function ThemePicker() {
  const theme = useTheme();
  return (
    <fieldset className="flex rounded-md border border-line p-0.5">
      <legend className="sr-only">Theme</legend>
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={theme === option.value}
          title={option.label}
          onClick={() => setTheme(option.value)}
          className={`inline-flex h-7 flex-1 items-center justify-center rounded-[5px] ${
            theme === option.value ? "bg-ground text-ink" : "text-muted hover:text-ink"
          }`}
        >
          <Icon name={option.icon} size={16} />
          <span className="sr-only">{option.label}</span>
        </button>
      ))}
    </fieldset>
  );
}
