import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { C, FONT } from "../constants";
import { Grain, PlateFrame, PlateLabel, Spores } from "../components/Stage";
import { SceneFade } from "../components/Transitions";

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

/** Squared botanical icon tiles (radius 0, hairline border). */
const Icon: React.FC<{ kind: string; ink: string; amber: string }> = ({
  kind,
  ink,
  amber,
}) => {
  const s = 34;
  const common = {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  switch (kind) {
    case "repo":
      return (
        <svg {...common} stroke={ink}>
          <path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zm0 0a2 2 0 0 0 2 2h13" />
          <path d="M9 7h6" stroke={amber} />
        </svg>
      );
    case "worker":
      return (
        <svg {...common} stroke={amber}>
          <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
        </svg>
      );
    case "database":
      return (
        <svg {...common} stroke={ink}>
          <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
          <path d="M4.5 5.5v6c0 1.6 3.4 2.8 7.5 2.8s7.5-1.2 7.5-2.8v-6" />
          <path
            d="M4.5 11.5v6c0 1.6 3.4 2.8 7.5 2.8s7.5-1.2 7.5-2.8v-6"
            stroke={amber}
          />
        </svg>
      );
    case "domain":
      return (
        <svg {...common} stroke={ink}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" />
        </svg>
      );
    case "auth":
      return (
        <svg {...common} stroke={amber}>
          <circle cx="8" cy="14" r="4" />
          <path d="M11 11 20 2M16 6l3 3M13 9l2 2" />
        </svg>
      );
    default:
      return null;
  }
};

type Node = {
  id: string;
  label: string;
  detail: string;
  kind: string;
  /** Tree position in a 0..1 box, trunk base at bottom center. */
  x: number;
  y: number;
  at: number;
};

const NODES: Node[] = [
  { id: "repo", label: "GitHub repo", detail: "source of truth", kind: "repo", x: 0.5, y: 0.3, at: 46 },
  { id: "worker", label: "Cloudflare Worker", detail: "its own deploy", kind: "worker", x: 0.24, y: 0.46, at: 62 },
  { id: "database", label: "D1 database", detail: "its own data", kind: "database", x: 0.76, y: 0.46, at: 78 },
  { id: "domain", label: "custom domain", detail: "its own address", kind: "domain", x: 0.34, y: 0.7, at: 94 },
  { id: "auth", label: "OIDC auth", detail: "its own keys", kind: "auth", x: 0.66, y: 0.7, at: 110 },
];

const TRUNK = { x: 0.5, y: 0.92 };

const CARD_W = 300;
const CARD_H = 128;

/** Scene III — the seed becomes a tree: every app is self-contained. */
export const Tree: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const trunkP = interpolate(frame, [14, 40], [0, 1], clamp);
  const titleP = interpolate(frame, [128, 150], [0, 1], clamp);

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <SceneFade durationInFrames={durationInFrames}>
        <Spores opacity={0.7} />
        <PlateFrame />
        {/* Connector lines */}
        <svg
          style={{ position: "absolute", inset: 0 }}
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
        >
          {NODES.map((n) => {
            const p = interpolate(frame, [n.at - 14, n.at + 8], [0, 1], clamp);
            const x1 = TRUNK.x * 1000;
            const y1 = TRUNK.y * 1000;
            const x2 = n.x * 1000;
            const y2 = (n.y + CARD_H / 2000) * 1000;
            return (
              <line
                key={n.id}
                x1={x1}
                y1={y1}
                x2={x1 + (x2 - x1) * p}
                y2={y1 + (y2 - y1) * p}
                stroke={C.hairline}
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>

        {/* Trunk sprout */}
        <div
          style={{
            position: "absolute",
            left: `${TRUNK.x * 100}%`,
            top: `${TRUNK.y * 100}%`,
            transform: "translate(-50%, -100%)",
            opacity: trunkP,
          }}
        >
          <svg width="120" height="150" viewBox="0 0 120 150" fill="none">
            <path
              d="M60 150 C60 100 60 70 60 40"
              stroke={C.brand}
              strokeWidth={5}
              strokeLinecap="round"
              strokeDasharray={120}
              strokeDashoffset={120 * (1 - trunkP)}
            />
            <path
              d="M60 96 C46 96 36 88 32 76 c12 0 24 8 28 20z"
              fill={C.brand}
              opacity={Math.max(0, trunkP * 2 - 1)}
            />
            <path
              d="M60 70 c10 0 20-7 24-18 -11 0-21 7-24 18z"
              fill={C.brand}
              opacity={Math.max(0, trunkP * 2 - 1.2)}
            />
          </svg>
        </div>

        {/* Node cards */}
        {NODES.map((n) => {
          const p = spring({
            frame: frame - n.at,
            fps,
            config: { damping: 15, stiffness: 130, mass: 0.8 },
          });
          if (p <= 0.001) return null;
          return (
            <div
              key={n.id}
              style={{
                position: "absolute",
                left: `${n.x * 100}%`,
                top: `${n.y * 100}%`,
                width: CARD_W,
                height: CARD_H,
                transform: `translate(-50%, -50%) scale(${0.6 + p * 0.4})`,
                opacity: p,
                background: "oklch(0.28 0.008 240)",
                border: `1px solid ${C.hairline}`,
                boxShadow: `0 18px 50px -18px rgba(0,0,0,0.6)`,
                display: "flex",
                alignItems: "center",
                gap: 18,
                padding: "0 22px",
              }}
            >
              <div
                style={{
                  width: 62,
                  height: 62,
                  border: `3px double ${C.hairline}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Icon kind={n.kind} ink={C.brand} amber={C.amber} />
              </div>
              <div>
                <div
                  style={{
                    fontFamily: FONT.display,
                    fontWeight: 600,
                    fontSize: 26,
                    color: C.fg,
                  }}
                >
                  {n.label}
                </div>
                <div
                  style={{
                    fontFamily: FONT.sans,
                    fontSize: 19,
                    color: C.muted,
                    marginTop: 4,
                  }}
                >
                  {n.detail}
                </div>
              </div>
            </div>
          );
        })}

        {/* Title */}
        <div
          style={{
            position: "absolute",
            top: 108,
            left: 0,
            right: 0,
            textAlign: "center",
            opacity: titleP,
            transform: `translateY(${(1 - titleP) * 24}px)`,
          }}
        >
          <div
            style={{
              fontFamily: FONT.display,
              fontWeight: 600,
              fontSize: 64,
              color: C.fg,
            }}
          >
            Every app is{" "}
            <em style={{ color: C.brand, fontWeight: 400 }}>self-contained</em>.
          </div>
        </div>

        <PlateLabel no="III" text="self-contained" />
      </SceneFade>
      <Grain />
    </AbsoluteFill>
  );
};
