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
import { FadeWords, FadeUp } from "../components/Text";
import { SceneFade } from "../components/Transitions";

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

/** Scene I — an acorn lands, is sealed into a glass jar, a sprout stirs. */
export const Seed: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Acorn drops in with a bounce.
  const drop = spring({
    frame: frame - 6,
    fps,
    config: { damping: 13, stiffness: 150, mass: 1.1 },
  });
  // Jar seals over it.
  const jar = spring({
    frame: frame - 40,
    fps,
    config: { damping: 20, stiffness: 90, mass: 1 },
  });
  // Sprout wakes at the very end of the scene.
  const sprout = interpolate(frame, [96, 116], [0, 1], clamp);

  const breathe = 1 + Math.sin(frame * 0.06) * 0.008;
  const logoScale = interpolate(drop, [0, 1], [1.15, 1]) * breathe;

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <SceneFade durationInFrames={durationInFrames}>
        <Spores />
        <PlateFrame />
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 120,
          }}
        >
          <div
            style={{
              transform: `scale(${logoScale})`,
              filter: `drop-shadow(0 0 ${60 * jar}px ${C.brandDim})`,
            }}
          >
            <LogoMark
              size={360}
              parts={{ acorn: drop, jar, sprout, brackets: 0 }}
            />
          </div>
          <div style={{ maxWidth: 760 }}>
            <FadeUp delay={58}>
              <div
                style={{
                  fontFamily: FONT.mono,
                  fontSize: 22,
                  letterSpacing: "0.3em",
                  textTransform: "uppercase",
                  color: C.muted,
                  marginBottom: 26,
                }}
              >
                vibe coding, cultivated
              </div>
            </FadeUp>
            <FadeWords
              text="Every vibe-coded app begins as a seed."
              delay={64}
              fontSize={74}
            />
          </div>
        </div>
        <PlateLabel no="I" text="the seed" />
      </SceneFade>
      <Grain />
    </AbsoluteFill>
  );
};
