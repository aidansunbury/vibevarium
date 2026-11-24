import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { C, FONT } from "../constants";
import { LogoMark } from "../components/LogoMark";
import { Grain, PlateFrame, Spores } from "../components/Stage";

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

/** Scene VII — the wordmark: vibevarium, grown not built. */
export const Wordmark: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const logoIn = spring({
    frame: frame - 6,
    fps,
    config: { damping: 16, stiffness: 90, mass: 1 },
  });
  const word = "vibevarium";
  const tagIn = interpolate(frame, [72, 92], [0, 1], clamp);
  const ruleP = interpolate(frame, [50, 74], [0, 1], clamp);
  const urlIn = interpolate(frame, [110, 132], [0, 1], clamp);
  const breathe = 1 + Math.sin(frame * 0.05) * 0.006;

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Spores opacity={0.8} />
      <PlateFrame />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            transform: `scale(${logoIn * breathe})`,
            opacity: logoIn,
            filter: `drop-shadow(0 0 55px ${C.brandDim})`,
            marginBottom: 34,
          }}
        >
          <LogoMark size={230} />
        </div>

        <div
          style={{
            fontFamily: FONT.display,
            fontWeight: 600,
            fontSize: 150,
            color: C.fg,
            letterSpacing: "0.01em",
            display: "flex",
          }}
        >
          {word.split("").map((ch, i) => {
            const p = spring({
              frame: frame - 22 - i * 2.2,
              fps,
              config: { damping: 20, stiffness: 130, mass: 0.8 },
            });
            return (
              <span
                key={i}
                style={{
                  opacity: p,
                  transform: `translateY(${(1 - p) * 40}px)`,
                  color: i >= 4 ? C.brand : C.fg,
                }}
              >
                {ch}
              </span>
            );
          })}
        </div>

        {/* double rule */}
        <div style={{ width: 620, marginTop: 30, opacity: ruleP }}>
          <div
            style={{
              borderTop: `3px double ${C.hairline}`,
              transform: `scaleX(${ruleP})`,
            }}
          />
        </div>

        <div
          style={{
            marginTop: 30,
            fontFamily: FONT.display,
            fontStyle: "italic",
            fontWeight: 400,
            fontSize: 52,
            color: C.muted,
            opacity: tagIn,
            transform: `translateY(${(1 - tagIn) * 22}px)`,
          }}
        >
          grown, <span style={{ color: C.amber }}>not built</span>.
        </div>

        <div
          style={{
            marginTop: 56,
            fontFamily: FONT.mono,
            fontSize: 26,
            letterSpacing: "0.3em",
            color: C.fg,
            opacity: urlIn,
            border: `1px solid ${C.hairline}`,
            padding: "14px 34px",
          }}
        >
          vibevarium<span style={{ color: C.brand }}>.com</span>
        </div>
      </div>
      <Grain />
    </AbsoluteFill>
  );
};
