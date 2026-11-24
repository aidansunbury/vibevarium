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
import { GlowScrub } from "../components/Text";
import { SceneFade } from "../components/Transitions";

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

const INK = C.paperInk;
const GREEN = "oklch(0.42 0.11 152)";
const AMBER = "#c88439";

type AppRow = {
  name: string;
  deploy: string;
  db: string;
  auth: string;
  at: number;
  prunedAt?: number;
};

const ROWS: AppRow[] = [
  { name: "ledger", deploy: "live", db: "d1", auth: "oidc", at: 42 },
  { name: "pollen", deploy: "live", db: "d1", auth: "oidc", at: 52 },
  { name: "mycelium", deploy: "live", db: "d1", auth: "oidc", at: 62 },
  { name: "old-fern", deploy: "pruned", db: "—", auth: "—", at: 72, prunedAt: 158 },
];

/**
 * Scene V — a light "field-guide" interlude: platform.vibevarium.com,
 * the gardener's ledger where apps are provisioned, inspected, pruned.
 */
export const Control: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const url = "platform.vibevarium.com";
  const cardIn = spring({
    frame: frame - 18,
    fps,
    config: { damping: 22, stiffness: 95, mass: 1 },
  });

  return (
    <AbsoluteFill style={{ background: C.paper }}>
      <SceneFade durationInFrames={durationInFrames}>
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
          {/* Browser chrome */}
          <div style={{ width: 1320, marginBottom: 22 }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 14,
                border: `1px solid ${INK}`,
                padding: "10px 22px",
                fontFamily: FONT.mono,
                fontSize: 24,
                color: INK,
                background: "oklch(0.99 0.006 110)",
              }}
            >
              <span style={{ color: GREEN }}>●</span>
              <GlowScrub
                text={url}
                start={4}
                end={34}
                color={INK}
                style={{ letterSpacing: "0.04em" }}
              />
            </div>
          </div>

          {/* Gardener's ledger card */}
          <div
            style={{
              width: 1320,
              background: "oklch(0.99 0.006 110)",
              border: `1px solid ${INK}`,
              boxShadow: `10px 10px 0 0 oklch(0.27 0.03 130 / 12%)`,
              opacity: cardIn,
              transform: `translateY(${(1 - cardIn) * 46}px)`,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                padding: "26px 34px 18px",
                borderBottom: `3px double ${INK}`,
              }}
            >
              <div
                style={{
                  fontFamily: FONT.display,
                  fontWeight: 600,
                  fontSize: 34,
                  color: INK,
                }}
              >
                The gardener&apos;s ledger
              </div>
              <div
                style={{
                  fontFamily: FONT.mono,
                  fontSize: 17,
                  letterSpacing: "0.22em",
                  textTransform: "uppercase",
                  color: "oklch(0.44 0.025 125)",
                }}
              >
                provision · inspect · prune
              </div>
            </div>

            {/* Table header */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "2fr 1.2fr 1fr 1fr 2.1fr",
                padding: "16px 34px",
                fontFamily: FONT.mono,
                fontSize: 16,
                letterSpacing: "0.24em",
                textTransform: "uppercase",
                color: "oklch(0.44 0.025 125)",
                borderBottom: `1px solid oklch(0.27 0.03 130 / 30%)`,
              }}
            >
              <span>app</span>
              <span>deploy</span>
              <span>data</span>
              <span>auth</span>
              <span>address</span>
            </div>

            {ROWS.map((row) => {
              const p = spring({
                frame: frame - row.at,
                fps,
                config: { damping: 20, stiffness: 140, mass: 0.8 },
              });
              if (p <= 0.001) return null;
              const pruneP =
                row.prunedAt === undefined
                  ? 0
                  : interpolate(frame, [row.prunedAt, row.prunedAt + 16], [0, 1], clamp);
              return (
                <div
                  key={row.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "2fr 1.2fr 1fr 1fr 2.1fr",
                    alignItems: "center",
                    padding: "18px 34px",
                    borderBottom: `1px solid oklch(0.27 0.03 130 / 18%)`,
                    opacity: p * (1 - pruneP * 0.75),
                    transform: `translateX(${(1 - p) * -26}px)`,
                    filter: pruneP > 0 ? `grayscale(${pruneP})` : "none",
                    position: "relative",
                  }}
                >
                  <span
                    style={{
                      fontFamily: FONT.display,
                      fontWeight: 600,
                      fontSize: 30,
                      color: INK,
                    }}
                  >
                    {row.name}
                  </span>
                  <span
                    style={{
                      fontFamily: FONT.mono,
                      fontSize: 21,
                      color: row.deploy === "live" ? GREEN : "oklch(0.5 0.19 27)",
                    }}
                  >
                    {row.deploy === "live" ? "● live" : "× pruned"}
                  </span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 21, color: INK }}>
                    {row.db}
                  </span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 21, color: INK }}>
                    {row.auth}
                  </span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 21, color: INK }}>
                    {row.name}.apps.vibevarium.com
                  </span>
                  {pruneP > 0 ? (
                    <span
                      style={{
                        position: "absolute",
                        left: "4%",
                        right: "4%",
                        top: "50%",
                        borderTop: `2px solid oklch(0.5 0.19 27)`,
                        opacity: pruneP,
                      }}
                    />
                  ) : null}
                </div>
              );
            })}

            {/* Prune caption */}
            <div
              style={{
                padding: "20px 34px 26px",
                fontFamily: FONT.sans,
                fontStyle: "italic",
                fontSize: 23,
                color: "oklch(0.44 0.025 125)",
                opacity: interpolate(frame, [168, 186], [0, 1], clamp),
              }}
            >
              <span style={{ color: AMBER }}>✂</span> prune an app and its repo,
              worker, database and auth client go with it.
            </div>
          </div>
        </div>

        <PlateFrame />
        <PlateLabel no="V" text="the gardener" light />
      </SceneFade>
      <Grain opacity={0.35} />
    </AbsoluteFill>
  );
};
