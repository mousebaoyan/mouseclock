import { cloneElement, useId, type ReactElement } from "react";
import { cn } from "~/cn";

// A labelled form control with an optional hint under it, tied to it for screen readers.
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-[13px] font-medium">
        {label}
      </label>
      {cloneElement(children, { id, "aria-describedby": hint ? hintId : undefined })}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

// The outcome of sending a form, above or below it.
export function FormMessage({ error, saved }: { error?: string; saved?: string | false }) {
  if (error)
    return (
      <p
        role="alert"
        className="rounded-lg border border-destructive/30 bg-[color-mix(in_oklab,var(--destructive)_6%,var(--card))] px-3.5 py-2.5 text-[13px] text-destructive"
      >
        {error}
      </p>
    );
  if (saved)
    return (
      <output className="block rounded-lg border border-success/30 bg-[color-mix(in_oklab,var(--success)_6%,var(--card))] px-3.5 py-2.5 text-[13px] text-success">
        {saved}
      </output>
    );
  return null;
}
