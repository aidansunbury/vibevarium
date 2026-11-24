import React from "react";
import { C } from "../constants";

/**
 * The vibevarium mark — a glass mason jar terrarium holding an acorn-rooted
 * sprout with amber </> code brackets above the leaves. Adapted from
 * docs/branding/logo.svg with every part exposed as a prop so scenes can
 * grow it piece by piece. All animated values are 0..1 progress numbers.
 */
export type LogoParts = {
  /** Jar outline + lid. */
  jar?: number;
  /** Amber </> brackets. */
  brackets?: number;
  /** Stem + leaves. */
  sprout?: number;
  /** Acorn shell + roots. */
  acorn?: number;
  glass?: boolean;
  glassOpacity?: number;
};

const clip = (v: number | undefined, fallback = 1): number =>
  Math.max(0, Math.min(1, v ?? fallback));

export const LogoMark: React.FC<{
  size?: number;
  parts?: LogoParts;
  ink?: string;
  amber?: string;
  style?: React.CSSProperties;
}> = ({ size = 200, parts = {}, ink = C.fg, amber = C.amber, style }) => {
  const jar = clip(parts.jar);
  const brackets = clip(parts.brackets);
  const sprout = clip(parts.sprout);
  const acorn = clip(parts.acorn);

  return (
    <svg
      viewBox="0 0 120 138"
      width={size}
      height={(size * 138) / 120}
      fill="none"
      style={style}
    >
      <g opacity={jar}>
        <rect x="27" y="4" width="66" height="14" rx="5" fill={ink} />
        <path
          d="M34 20v6c-7 6-15 10-15 25v50c0 14 10 22 28 22h26c18 0 28-8 28-22V51c0-15-8-19-15-25v-6"
          stroke={ink}
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {parts.glass !== false ? (
          <>
            <path
              d="M44 31h18M74 31h3"
              stroke={C.paper}
              strokeWidth="3"
              strokeLinecap="round"
              opacity={parts.glassOpacity ?? 0.85}
            />
            <path
              d="M28 49c-3 4-3 9-3 14M25 68v3"
              stroke={C.paper}
              strokeWidth="3"
              strokeLinecap="round"
              opacity={parts.glassOpacity ?? 0.85}
            />
          </>
        ) : null}
      </g>
      <g opacity={brackets}>
        <path
          d="M54 42l-9 8 9 8M66 42l9 8-9 8"
          stroke={amber}
          strokeWidth="5.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <g opacity={sprout}>
        <path
          d="M60 66V80"
          stroke={ink}
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        <path
          d="M60 82C51 82 42 77 38 68c9 0 17 5 22 14z"
          fill={ink}
          opacity={Math.max(0, sprout * 2 - 1)}
        />
        <path
          d="M60 82c9 0 18-5 22-14-9 0-17 5-22 14z"
          fill={ink}
          opacity={Math.max(0, sprout * 2 - 1)}
        />
      </g>
      <g opacity={acorn}>
        <path
          d="M53 89c0-6 3-9 7-9s7 3 7 9"
          stroke={ink}
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        <path d="M60 96h12v5c0 10-5 17-12 22z" fill={ink} />
        <path
          d="M48 96h24v5c0 10-5 17-12 22-7-5-12-12-12-22v-5z"
          stroke={ink}
          strokeWidth="4.5"
          strokeLinejoin="round"
        />
        <path
          d="M65 101l4-3M66 107l3 3"
          stroke={C.paper}
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path
          d="M46 104c-7 0-12 3-16 9M37 105l-6-4M40 107l-3 7"
          stroke={ink}
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={Math.max(0, acorn * 2 - 1)}
        />
        <path
          d="M74 104c7 0 12 3 16 9M83 105l6-4M80 107l3 7"
          stroke={ink}
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={Math.max(0, acorn * 2 - 1)}
        />
      </g>
    </svg>
  );
};
