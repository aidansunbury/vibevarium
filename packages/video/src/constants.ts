export const FPS = 30;

/** Seconds per scene, in narrative order. */
export const SCENES = {
  seed: 4,
  command: 5,
  tree: 7,
  garden: 5.5,
  control: 7.5,
  keys: 5,
  wordmark: 6.5,
} as const;

const SECONDS = Object.values(SCENES).reduce((a, b) => a + b, 0);
export const TOTAL_FRAMES = Math.round(SECONDS * FPS);

/** Botanical-print palette (packages/ui globals.css), dark "Graphite" mode. */
export const C = {
  bg: "oklch(0.235 0.006 240)",
  fg: "oklch(0.94 0.008 140)",
  muted: "oklch(0.76 0.01 180)",
  faint: "oklch(0.94 0.008 140 / 26%)",
  hairline: "oklch(0.94 0.008 140 / 50%)",
  brand: "oklch(0.8 0.12 155)",
  brandDim: "oklch(0.8 0.12 155 / 22%)",
  amber: "#d89a54",
  amberDim: "#d89a54 / 22%",
  ink: "#0d140e",
  paper: "oklch(0.975 0.008 110)",
  paperInk: "oklch(0.27 0.03 130)",
  glass: "oklch(0.94 0.008 140 / 7%)",
} as const;

export const FONT = {
  display: '"Fraunces", Georgia, serif',
  sans: '"Source Sans 3", system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
} as const;
