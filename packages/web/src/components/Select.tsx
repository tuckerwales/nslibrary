import type { ReactNode, SelectHTMLAttributes } from "react";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  children: ReactNode;
}

export function Select({ label, className = "", children, ...props }: SelectProps) {
  return (
    <label className={`block text-sm font-semibold ${className}`}>
      {label}
      <select
        className="mt-1.5 h-10 w-full rounded-md border border-line bg-panel px-3 text-base font-normal text-ink"
        {...props}
      >
        {children}
      </select>
    </label>
  );
}
