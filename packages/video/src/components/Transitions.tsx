import React from "react";
import { interpolate, useCurrentFrame } from "remotion";

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

/**
 * Wraps a scene: quick fade-in, and in the last `outFrames` frames the
 * content sinks slightly and fades — a gentle hand-off to the next scene.
 */
export const SceneFade: React.FC<{
  durationInFrames: number;
  children: React.ReactNode;
  inFrames?: number;
  outFrames?: number;
}> = ({ durationInFrames, children, inFrames = 10, outFrames = 10 }) => {
  const frame = useCurrentFrame();
  const fadeIn = interpolate(frame, [0, inFrames], [0, 1], clamp);
  const fadeOut = interpolate(
    frame,
    [durationInFrames - outFrames, durationInFrames - 1],
    [1, 0],
    clamp,
  );
  const sink = interpolate(
    frame,
    [durationInFrames - outFrames, durationInFrames - 1],
    [0, 18],
    clamp,
  );
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: Math.min(fadeIn, fadeOut),
        transform: `translateY(${sink}px)`,
      }}
    >
      {children}
    </div>
  );
};
