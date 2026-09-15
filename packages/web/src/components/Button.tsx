import type { ButtonHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:brightness-110",
  secondary: "border border-line bg-panel text-ink hover:border-muted",
  ghost: "text-muted hover:text-ink",
  danger: "bg-danger text-panel hover:brightness-110",
};

function buttonClass(variant: Variant, className: string): string {
  return `inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-semibold whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`;
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
