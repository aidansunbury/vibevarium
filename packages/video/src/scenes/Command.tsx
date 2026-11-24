import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { C, FONT } from "../constants";
import { Grain, PlateFrame, PlateLabel } from "../components/Stage";
import { Typewriter, FadeUp } from "../components/Text";
import { SceneFade } from "../components/Transitions";

type Line =
  | { kind: "cmd"; text: string; at: number }
  | { kind: "out"; text: string; at: number; tone?: "ok" | "dim" };

const LINES: Line[] = [
  { kind: "cmd", text: "vibevarium grow ledger", at: 8 },
  { kind: "out", text: "✓ repo        github.com/you/ledger", at: 62, tone: "ok" },
  { kind: "out", text: "✓ worker      ledger.apps.vibevarium.com", at: 76, tone: "ok" },
  { kind: "out", text: "✓ database    d1 · ledger-db", at: 90, tone: "ok" },
  { kind: "out", text: "✓ auth        oidc client · issued", at: 104, tone: "ok" },
  { kind: "out", text: "✓ domain      ledger.example.com · dns live", at: 118, tone: "ok" },
  { kind: "out", text: "grown in 41s — welcome to the garden", at: 136, tone: "dim" },
];

/** Scene II — one command scaffolds repo, worker, database, auth, domain. */
export const Command: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const termIn = spring({
    frame: frame - 4,
    fps,
    config: { damping: 22, stiffness: 100, mass: 1 },
  });

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <SceneFade durationInFrames={durationInFrames}>
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
          <FadeUp delay={0}>
            <div
              style={{
                fontFamily: FONT.display,
                fontStyle: "italic",
                fontWeight: 400,
                fontSize: 40,
                color: C.muted,
                textAlign: "center",
                marginBottom: 44,
                opacity: interpolate(frame, [0, 20], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
              }}
            >
              one command grows an app
            </div>
          </FadeUp>
          <div
            style={{
              width: 1060,
              background: "oklch(0.19 0.006 240)",
              border: `1px solid ${C.hairline}`,
              boxShadow: `0 30px 80px -20px rgba(0,0,0,0.55), 0 0 0 6px ${C.glass}`,
              opacity: termIn,
              transform: `translateY(${(1 - termIn) * 40}px) scale(${0.97 + termIn * 0.03})`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "14px 20px",
                borderBottom: `1px solid ${C.faint}`,
              }}
            >
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    border: `1.5px solid ${C.hairline}`,
                  }}
                />
              ))}
              <div
                style={{
                  marginLeft: 16,
                  fontFamily: FONT.mono,
                  fontSize: 17,
                  color: C.muted,
                  letterSpacing: "0.12em",
                }}
              >
                gardener — zsh
              </div>
            </div>
            <div style={{ padding: "30px 34px 36px", minHeight: 380 }}>
              {LINES.map((line, i) => {
                if (line.kind === "cmd") {
                  return (
                    <div key={i} style={{ fontSize: 30, marginBottom: 20 }}>
                      <span style={{ color: C.brand, fontFamily: FONT.mono }}>
                        ${" "}
                      </span>
                      <Typewriter
                        text={line.text}
                        delay={line.at}
                        style={{ color: C.fg, fontSize: 30 }}
                      />
                    </div>
                  );
                }
                const p = spring({
                  frame: frame - line.at,
                  fps,
                  config: { damping: 24, stiffness: 160, mass: 0.7 },
                });
                if (p <= 0) return null;
                return (
                  <div
                    key={i}
                    style={{
                      fontFamily: FONT.mono,
                      fontSize: 24,
                      marginBottom: 12,
                      opacity: p,
                      transform: `translateX(${(1 - p) * -18}px)`,
                      color:
                        line.tone === "ok"
                          ? C.fg
                          : line.tone === "dim"
                            ? C.muted
                            : C.fg,
                    }}
                  >
                    {line.text.startsWith("✓") ? (
                      <>
                        <span style={{ color: C.brand }}>✓</span>
                        <span style={{ color: C.faint }}>{"  ·  "}</span>
                        {line.text.slice(2)}
                      </>
                    ) : (
                      line.text
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <PlateLabel no="II" text="one command" />
      </SceneFade>
      <Grain />
    </AbsoluteFill>
  );
};
