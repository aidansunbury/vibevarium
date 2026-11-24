import * as React from "react";
import { cn } from "../lib/utils";

/**
 * The vibevarium mark: a glass mason-jar vibevarium holding an acorn-rooted
 * sprout, with amber code brackets (`</>`) growing above the leaves.
 *
 * Ink uses `currentColor` (inherits text color); the brackets take
 * `--logo-bracket` (default: pressed-clay amber, light/dark aware via the
 * `--brand-bracket` theme var). Glass glints use `--logo-glass`, which the
 * theme sets to the paper color so the highlight reads as glass.
 */
function Logo({ className, ...props }: React.ComponentProps<"svg">) {
  const ink = "currentColor";
  const glass = "var(--logo-glass, var(--background))";
  const bracket = "var(--logo-bracket, var(--brand-bracket, #c88439))";
  return (
    <svg
      data-slot="logo"
      viewBox="0 0 120 138"
      fill="none"
      aria-hidden="true"
      className={cn("size-6", className)}
      {...props}
    >
      {/* lid */}
      <rect x="30" y="6" width="60" height="13" rx="4" fill={ink} />
      {/* jar walls */}
      <path
        d="M36 19v8c-7 7-13 11-13 25v45c0 13 9 21 26 21h22c17 0 26-8 26-21V52c0-14-6-18-13-25v-8"
        stroke={ink}
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* glass glints */}
      <path d="M45 31h14M30 51c-2 4-2 8-2 11" stroke={glass} strokeWidth="2.6" strokeLinecap="round" />
      {/* code brackets */}
      <path
        d="M53 43l-9 8 9 8M67 43l9 8-9 8"
        stroke={bracket}
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* stem */}
      <path d="M60 66v16" stroke={ink} strokeWidth="5" strokeLinecap="round" />
      {/* leaves */}
      <path d="M60 82c-10 0-19-6-22-16 10 0 19 6 22 16z" fill={ink} />
      <path d="M60 82c10 0 19-6 22-16-10 0-19 6-22 16z" fill={ink} />
      {/* roots */}
      <path
        d="M46 98c-6 0-11 3-14 9M38 99l-6-4M40 102l-2 7"
        stroke={ink}
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M74 98c6 0 11 3 14 9M82 99l6-4M80 102l2 7"
        stroke={ink}
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* acorn: stem + cap + shell */}
      <path d="M60 94v-4" stroke={ink} strokeWidth="4.5" strokeLinecap="round" />
      <path d="M50 95c0-8 4-11 10-11s10 3 10 11" stroke={ink} strokeWidth="5" strokeLinecap="round" />
      <path d="M50 95h20v7c0 10-4.5 17.5-10 22.5-5.5-5-10-12.5-10-22.5v-7z" fill={ink} />
      <path d="M52 97h16" stroke={glass} strokeWidth="2.4" strokeLinecap="round" />
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
      <Logo className="h-6 w-auto shrink-0" />
      <span className="font-semibold tracking-[0.01em]" style={{ fontFamily: "var(--font-display)" }}>
        {children}
      </span>
    </span>
  );
}

export { Logo, LogoLockup };
