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
import { Grain, PlateFrame, PlateLabel, Spores } from "../components/Stage";
import { SceneFade } from "../components/Transitions";

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

type Jar = { x: number; y: number; size: number; at: number; depth: number };

const JARS: Jar[] = [
  // back row
  { x: 0.14, y: 0.34, size: 120, at: 6, depth: 0.4 },
  { x: 0.38, y: 0.28, size: 105, at: 12, depth: 0.35 },
  { x: 0.62, y: 0.3, size: 112, at: 9, depth: 0.38 },
  { x: 0.86, y: 0.33, size: 118, at: 15, depth: 0.42 },
  // front row
  { x: 0.22, y: 0.62, size: 175, at: 20, depth: 0.8 },
  { x: 0.5, y: 0.66, size: 195, at: 26, depth: 1 },
  { x: 0.78, y: 0.62, size: 170, at: 23, depth: 0.75 },
];

/** Scene IV — the camera pulls back: not one jar, a whole garden of apps. */
export const Garden: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Slow camera drift + a gentle pull-back across the scene.
  const cam = interpolate(frame, [0, durationInFrames], [1.14, 1.0], clamp);
  const titleP = interpolate(frame, [58, 80], [0, 1], clamp);

  return (
    <AbsoluteFill style={{ background: C.bg, overflow: "hidden" }}>
      <SceneFade durationInFrames={durationInFrames}>
        <Spores />
        <PlateFrame />
        <div
          style={{
            position: "absolute",
            inset: -80,
            transform: `scale(${cam})`,
            transformOrigin: "50% 58%",
          }}
        >
          {/* shelf lines */}
          {[0.48, 0.82].map((y, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: "6%",
                right: "6%",
                top: `${y * 100}%`,
                borderTop: `1px solid ${C.faint}`,
              }}
            />
          ))}
          {JARS.map((jar, i) => {
            const p = spring({
              frame: frame - jar.at,
              fps,
              config: { damping: 18, stiffness: 110, mass: 0.9 },
            });
            const sway = Math.sin(frame * 0.05 + i * 1.7) * 1.5;
            const sprout = interpolate(frame, [jar.at + 8, jar.at + 30], [0, 1], clamp);
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: `${jar.x * 100}%`,
                  top: `${jar.y * 100}%`,
                  transform: `translate(-50%, -50%) scale(${0.7 + p * 0.3}) rotate(${sway}deg)`,
                  opacity: p * (0.55 + jar.depth * 0.45),
                  filter: jar.depth < 0.6 ? "blur(1.5px)" : "none",
                }}
              >
                <LogoMark
                  size={jar.size}
                  parts={{
                    jar: p,
                    acorn: p,
                    sprout,
                    brackets: interpolate(frame, [jar.at + 18, jar.at + 34], [0, 1], clamp),
                  }}
                />
              </div>
            );
          })}
        </div>

        <div
          style={{
            position: "absolute",
            bottom: 170,
            left: 0,
            right: 0,
            textAlign: "center",
            opacity: titleP,
            transform: `translateY(${(1 - titleP) * 26}px)`,
          }}
        >
          <div
            style={{
              fontFamily: FONT.display,
              fontWeight: 600,
              fontSize: 58,
              color: C.fg,
              textShadow: "0 4px 30px rgba(0,0,0,0.5)",
            }}
          >
            …and your garden{" "}
            <em style={{ color: C.brand, fontWeight: 400 }}>grows</em>.
          </div>
        </div>

        <PlateLabel no="IV" text="the garden" />
      </SceneFade>
      <Grain />
    </AbsoluteFill>
  );
};
