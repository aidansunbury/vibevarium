import * as React from "react";
import { cn } from "../lib/utils";

/**
 * The vibevarium mark: a glass apothecary jar vibevarium whose sprout leaves
 * are code brackets (`</>`). Stroke uses `currentColor` (inherits text ink);
 * the sprout takes the brand accents, overridable via CSS variables:
 *
 *   <Logo style={{ "--logo-a": "...", "--logo-b": "..." }} />
 */
function Logo({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      data-slot="logo"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={cn("size-6", className)}
      {...props}
    >
      {/* jar */}
      <path d="M20 14h24" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
      <path
        d="M23 14v6c0 2-1.2 3.4-2.6 4.6C17.6 27 16 29.6 16 33v14a8 8 0 0 0 8 8h16a8 8 0 0 0 8-8V33c0-3.4-1.6-6-4.4-8.4C42.2 23.4 41 22 41 20v-6"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* soil line */}
      <path
        d="M21 45c4-2 8 1 11-1s7-1 11 1"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity=".45"
      />
      {/* sprout stem */}
      <path d="M32 45V33" stroke="var(--logo-a, var(--primary, currentColor))" strokeWidth="3" strokeLinecap="round" />
      {/* leaves as angle brackets */}
      <path
        d="M29 27l-5 4 5 4"
        stroke="var(--logo-a, var(--primary, currentColor))"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M35 27l5 4-5 4"
        stroke="var(--logo-b, var(--brand-secondary, currentColor))"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Mark + wordmark lockup for headers. */
function LogoLockup({
  className,
  children = "vibevarium",
  ...props
}: React.ComponentProps<"span"> & { children?: React.ReactNode }) {
  return (
    <span data-slot="logo-lockup" className={cn("inline-flex items-center gap-2", className)} {...props}>
      <Logo className="size-5 shrink-0" />
      <span className="font-semibold tracking-[0.01em]" style={{ fontFamily: "var(--font-display)" }}>
        {children}
      </span>
    </span>
  );
}

export { Logo, LogoLockup };
