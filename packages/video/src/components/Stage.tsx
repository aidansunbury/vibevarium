import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, FONT } from "../constants";

const GRAIN = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="p"><feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="3"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.09"/></feComponentTransfer></filter><rect width="180" height="180" filter="url(%23p)"/></svg>')`;

/** Laid-paper grain over everything (the brand's field-guide texture). */
export const Grain: React.FC<{ opacity?: number }> = ({ opacity = 0.5 }) => (
  <AbsoluteFill
    style={{
      backgroundImage: GRAIN,
      mixBlendMode: "overlay",
      opacity,
      pointerEvents: "none",
    }}
  />
);

/** Squared botanical plate border: hairline + 3px double rule. */
export const PlateFrame: React.FC<{ inset?: number; opacity?: number }> = ({
  inset = 46,
  opacity = 1,
}) => (
  <AbsoluteFill style={{ pointerEvents: "none", opacity }}>
    <div
      style={{
        position: "absolute",
        inset,
        border: `1px solid ${C.hairline}`,
      }}
    />
    <div style={{ position: "absolute", inset: inset + 8, border: `3px double ${C.hairline}` }} />
  </AbsoluteFill>
);

/**
 * Specimen-label caption pinned bottom-left, like a pressed-plant tag:
 * "No. II — one command" in small-caps mono.
 */
export const PlateLabel: React.FC<{ no: string; text: string; light?: boolean }> = ({
  no,
  text,
  light,
}) => (
  <div
    style={{
      position: "absolute",
      left: 72,
      bottom: 58,
      fontFamily: FONT.mono,
      fontSize: 20,
      letterSpacing: "0.28em",
      textTransform: "uppercase",
      color: light ? C.paperInk : C.muted,
    }}
  >
    <span style={{ color: C.amber }}>{no}</span>
    <span style={{ opacity: 0.55 }}> — </span>
    {text}
  </div>
);

const DRIFTS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  // [x%, y%, size, speed, phase]
  [8, 22, 7, 0.021, 0],
  [14, 68, 5, 0.017, 1.4],
  [26, 12, 6, 0.025, 2.8],
  [38, 84, 8, 0.014, 0.6],
  [52, 20, 5, 0.028, 3.9],
  [63, 74, 7, 0.019, 2.1],
  [74, 14, 6, 0.023, 4.4],
  [84, 58, 8, 0.016, 1.1],
  [92, 30, 5, 0.027, 5.2],
  [46, 55, 4, 0.031, 3.1],
  [70, 42, 4, 0.026, 0.9],
  [20, 45, 4, 0.024, 2.4],
  [88, 80, 6, 0.018, 4.9],
  [34, 34, 5, 0.022, 5.8],
  [58, 8, 4, 0.029, 1.9],
  [5, 85, 5, 0.02, 3.5],
];

/** Slow-drifting amber/green motes — spores floating in the greenhouse air. */
export const Spores: React.FC<{ opacity?: number }> = ({ opacity = 1 }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity }}>
      {DRIFTS.map(([x, y, s, speed, phase], i) => {
        const dx = Math.sin(frame * speed + phase) * 14;
        const dy = Math.cos(frame * speed * 0.8 + phase * 2) * 18 - frame * 0.01;
        const tw = 0.35 + 0.65 * Math.abs(Math.sin(frame * 0.045 + phase * 3));
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${x}%`,
              top: `${y}%`,
              width: s,
              height: s,
              borderRadius: "50%",
              background: i % 3 === 0 ? C.amber : C.brand,
              opacity: 0.14 + 0.3 * tw,
              transform: `translate(${dx}px, ${dy}px)`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
