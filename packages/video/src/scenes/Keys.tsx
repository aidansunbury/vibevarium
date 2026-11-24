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

const KeyIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="8" cy="14" r="4.5" />
    <path d="M11.2 10.8 21 1M17 5l3 3M14 8l2.5 2.5" />
  </svg>
);

const LockIcon: React.FC<{ size: number; color: string; open: number }> = ({
  size,
  color,
  open,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="5" y="11" width="14" height="9" />
    <path
      d="M8 11V7a4 4 0 0 1 8 0v4"
      style={{
        transform: `translateY(${-open * 3}px) rotate(${open * -14}deg)`,
        transformOrigin: "8px 11px",
      }}
    />
  </svg>
);

const DOORS = [
  { label: "gateway", detail: "platform.vibevarium.com", at: 40 },
  { label: "ledger", detail: "your app", at: 54 },
  { label: "pollen", detail: "your app", at: 62 },
  { label: "mycelium", detail: "your app", at: 70 },
];

/** Scene VI — one OIDC token unlocks the gateway and every app. */
export const Keys: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const keyIn = spring({
    frame: frame - 10,
    fps,
    config: { damping: 14, stiffness: 110, mass: 0.9 },
  });
  const ringPulse = interpolate(frame, [46, 96], [0, 1], clamp);

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <SceneFade durationInFrames={durationInFrames}>
        <Spores opacity={0.6} />
        <PlateFrame />

        <div
          style={{
            position: "absolute",
            top: 118,
            left: 0,
            right: 0,
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: FONT.display,
              fontWeight: 600,
              fontSize: 62,
              color: C.fg,
              opacity: keyIn,
              transform: `translateY(${(1 - keyIn) * 26}px)`,
            }}
          >
            One token opens{" "}
            <em style={{ color: C.amber, fontWeight: 400 }}>everything</em>.
          </div>
          <div
            style={{
              fontFamily: FONT.sans,
              fontSize: 26,
              color: C.muted,
              marginTop: 18,
              opacity: interpolate(frame, [26, 42], [0, 1], clamp),
            }}
          >
            an OIDC boundary around the whole garden — not a pile of API keys
          </div>
        </div>

        {/* The key */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "62%",
            transform: `translate(-50%, -50%) scale(${0.5 + keyIn * 0.5}) rotate(${(1 - keyIn) * -30}deg)`,
            opacity: keyIn,
          }}
        >
          {/* pulse rings */}
          {[0, 1, 2].map((i) => {
            const rp = (ringPulse + i / 3) % 1;
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: 200 + rp * 620,
                  height: 200 + rp * 620,
                  transform: "translate(-50%, -50%)",
                  borderRadius: "50%",
                  border: `1.5px solid ${C.amber}`,
                  opacity: (1 - rp) * 0.35,
                }}
              />
            );
          })}
          <div
            style={{
              width: 150,
              height: 150,
              border: `3px double ${C.amber}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "oklch(0.28 0.008 240)",
              boxShadow: `0 0 70px ${C.brandDim}`,
            }}
          >
            <KeyIcon size={74} color={C.amber} />
          </div>
          <div
            style={{
              textAlign: "center",
              marginTop: 18,
              fontFamily: FONT.mono,
              fontSize: 20,
              letterSpacing: "0.26em",
              textTransform: "uppercase",
              color: C.muted,
            }}
          >
            platform token
          </div>
        </div>

        {/* Doors / apps it unlocks */}
        {DOORS.map((door, i) => {
          const p = spring({
            frame: frame - door.at,
            fps,
            config: { damping: 16, stiffness: 140, mass: 0.8 },
          });
          if (p <= 0.001) return null;
          const x = 18 + i * 21.5;
          return (
            <div
              key={door.label}
              style={{
                position: "absolute",
                left: `${x}%`,
                bottom: 130,
                transform: `translateX(-50%) translateY(${(1 - p) * 30}px)`,
                opacity: p,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
              }}
            >
              <LockIcon size={44} color={C.brand} open={p} />
              <div
                style={{
                  fontFamily: FONT.display,
                  fontWeight: 600,
                  fontSize: 26,
                  color: C.fg,
                }}
              >
                {door.label}
              </div>
              <div
                style={{
                  fontFamily: FONT.mono,
                  fontSize: 16,
                  color: C.muted,
                }}
              >
                {door.detail}
              </div>
            </div>
          );
        })}

        <PlateLabel no="VI" text="one key" />
      </SceneFade>
      <Grain />
    </AbsoluteFill>
  );
};
