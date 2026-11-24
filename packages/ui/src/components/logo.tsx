import * as React from "react";
import { cn } from "../lib/utils";

/**
 * The vibevarium mark: a glass mason-jar terrarium holding an acorn-rooted
 * sprout, with amber code brackets (`</>`) growing above the leaves.
 *
 * Ink uses `currentColor` (inherits text color); the brackets take
 * `--logo-bracket` (default: pressed-clay amber via the `--brand-bracket`
 * theme var). Glass glints use `--logo-glass`, which the theme sets to the
 * paper color so the highlight reads as glass.
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
      <rect x="27" y="4" width="66" height="14" rx="5" fill={ink} />
      {/* jar walls */}
      <path
        d="M34 20v6c-7 6-15 10-15 25v50c0 14 10 22 28 22h26c18 0 28-8 28-22V51c0-15-8-19-15-25v-6"
        stroke={ink}
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* glass glints */}
      <path d="M44 31h18M74 31h3" stroke={glass} strokeWidth="3" strokeLinecap="round" />
      <path d="M28 49c-3 4-3 9-3 14M25 68v3" stroke={glass} strokeWidth="3" strokeLinecap="round" />
      {/* code brackets */}
      <path
        d="M54 42l-9 8 9 8M66 42l9 8-9 8"
        stroke={bracket}
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* stem */}
      <path d="M60 64v14" stroke={ink} strokeWidth="4.5" strokeLinecap="round" />
      {/* leaves */}
      <path d="M60 76c-9 0-17-5-20-13 9 0 17 5 20 13z" fill={ink} />
      <path d="M60 76c9 0 17-5 20-13-9 0-17 5-20 13z" fill={ink} />
      {/* roots */}
      <path
        d="M44 102c-7 0-12 3-15 9M35 103l-6-4M38 106l-3 7M42 108l-2 6"
        stroke={ink}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M76 102c7 0 12 3 15 9M85 103l6-4M82 106l3 7M78 108l2 6"
        stroke={ink}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* acorn: cap is a small floating arc (gap before the shield); the
          shield nut is a stroked outline filled on the right half, with
          paper accent ticks on the filled side */}
      <path d="M53 89c0-6 3-9 7-9s7 3 7 9" stroke={ink} strokeWidth="4.5" strokeLinecap="round" />
      <path d="M60 96h12v5c0 10-5 17-12 22z" fill={ink} />
      <path
        d="M48 96h24v5c0 10-5 17-12 22-7-5-12-12-12-22v-5z"
        stroke={ink}
        strokeWidth="4.5"
        strokeLinejoin="round"
      />
      <path d="M65 101l4-3M66 107l3 3" stroke={glass} strokeWidth="2.4" strokeLinecap="round" />
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
