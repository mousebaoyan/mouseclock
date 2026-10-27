import type * as React from "react";
import { cn } from "~/cn";

// The class for each look, defined in app.css.
const VARIANTS = {
  default: "btn-primary",
  outline: "btn-outline",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  destructive: "btn-destructive",
  link: "btn-link",
};

const SIZES = {
  default: "btn-md",
  xs: "btn-xs",
  sm: "btn-sm",
  lg: "btn-lg",
  icon: "btn-icon",
  "icon-sm": "btn-icon-sm",
};

type Looks = { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES; className?: string };

export function buttonVariants({ variant = "default", size = "default", className }: Looks = {}) {
  return cn("btn", VARIANTS[variant], SIZES[size], className);
}

export function Button({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"button"> & Omit<Looks, "className">) {
  return <button className={buttonVariants({ variant, size, className })} {...props} />;
}
