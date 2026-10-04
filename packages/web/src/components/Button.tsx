import type { ButtonHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router";

type Variant = "primary" | "secondary" | "ghost" | "danger";

// Disabled buttons drop their fill, so they read as unavailable rather than faded but clickable.
const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-ink shadow-card hover:brightness-110 disabled:bg-line disabled:text-muted disabled:shadow-none disabled:hover:brightness-100",
  secondary:
    "border border-line bg-panel text-ink shadow-card hover:border-muted disabled:bg-transparent disabled:text-muted disabled:shadow-none disabled:hover:border-line",
  ghost:
    "text-muted hover:bg-line/40 hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent",
  danger:
    "bg-danger text-panel hover:brightness-110 disabled:bg-line disabled:text-muted disabled:hover:brightness-100",
};

function buttonClass(variant: Variant, className: string): string {
  return `inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-4 text-sm font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}

/** A link that looks like a button, for navigation actions. */
export function ButtonLink({
  variant = "primary",
  className = "",
  ...props
}: LinkProps & { variant?: Variant }) {
  return <Link className={buttonClass(variant, className)} {...props} />;
}
