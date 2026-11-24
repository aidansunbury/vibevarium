import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT } from "../constants";

/** Words rising into place with a soft spring, staggered per word. */
export const FadeWords: React.FC<{
  text: string;
  delay?: number;
  stagger?: number;
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  italic?: boolean;
  weight?: number;
  lineHeight?: number;
  style?: React.CSSProperties;
}> = ({
  text,
  delay = 0,
  stagger = 4,
  fontSize = 96,
  color = C.fg,
  fontFamily = FONT.display,
  italic = false,
  weight = 600,
  lineHeight = 1.08,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(" ");
  return (
    <div style={{ fontFamily, fontSize, color, lineHeight, fontWeight: weight, fontStyle: italic ? "italic" : "normal", ...style }}>
      {words.map((w, i) => {
        const p = spring({
          frame: frame - delay - i * stagger,
          fps,
          config: { damping: 22, stiffness: 120, mass: 0.9 },
        });
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              whiteSpace: "pre",
              opacity: p,
              transform: `translateY(${(1 - p) * 44}px)`,
            }}
          >
            {w + (i < words.length - 1 ? " " : "")}
          </span>
        );
      })}
    </div>
  );
};

/** Body line that fades/slides up as one block. */
export const FadeUp: React.FC<{
  children: React.ReactNode;
  delay?: number;
  distance?: number;
  style?: React.CSSProperties;
}> = ({ children, delay = 0, distance = 26, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({
    frame: frame - delay,
    fps,
    config: { damping: 24, stiffness: 110, mass: 0.9 },
  });
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${(1 - p) * distance}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** Typewriter for mono terminal text, with a block caret. */
export const Typewriter: React.FC<{
  text: string;
  delay?: number;
  charsPerFrame?: number;
  caret?: boolean;
  style?: React.CSSProperties;
}> = ({ text, delay = 0, charsPerFrame = 0.6, caret = true, style }) => {
  const frame = useCurrentFrame();
  const shown = Math.floor(Math.max(0, frame - delay) * charsPerFrame);
  const slice = text.slice(0, shown);
  const caretOn = Math.floor(frame / 14) % 2 === 0;
  return (
    <span style={{ fontFamily: FONT.mono, whiteSpace: "pre", ...style }}>
      {slice}
      {caret ? (
        <span style={{ opacity: caretOn ? 1 : 0, color: C.amber }}>▍</span>
      ) : null}
    </span>
  );
};

/** Text that scrubs letter-by-letter from dim to brand-green (or amber). */
export const GlowScrub: React.FC<{
  text: string;
  start: number;
  end: number;
  color?: string;
  style?: React.CSSProperties;
}> = ({ text, start, end, color = C.brand, style }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const lit = Math.floor(p * text.length);
  return (
    <span style={style}>
      {text.split("").map((ch, i) => (
        <span key={i} style={{ color: i < lit ? color : C.faint }}>
          {ch}
        </span>
      ))}
    </span>
  );
};
