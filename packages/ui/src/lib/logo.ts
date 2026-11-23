/**
 * The vibevarium mark: a glass apothecary jar vibevarium whose sprout leaves
 * are code brackets (`</>`), as a standalone SVG string. Use for favicons,
 * static HTML, and anywhere a React component won't do.
 *
 * `{ink}`, `{a}`, `{b}` are literal placeholders — replace with colors, or
 * keep the defaults via `logoSvg()` below.
 */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><path d="M20 14h24" stroke="{ink}" stroke-width="3.5" stroke-linecap="round"/><path d="M23 14v6c0 2-1.2 3.4-2.6 4.6C17.6 27 16 29.6 16 33v14a8 8 0 0 0 8 8h16a8 8 0 0 0 8-8V33c0-3.4-1.6-6-4.4-8.4C42.2 23.4 41 22 41 20v-6" stroke="{ink}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 45c4-2 8 1 11-1s7-1 11 1" stroke="{ink}" stroke-width="2.5" stroke-linecap="round" opacity=".45"/><path d="M32 45V33" stroke="{a}" stroke-width="3" stroke-linecap="round"/><path d="M29 27l-5 4 5 4" stroke="{a}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M35 27l5 4-5 4" stroke="{b}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Logo SVG with concrete colors. Defaults to the Vellum light-mode inks. */
export function logoSvg({
  ink = "#22291a",
  a = "#015d2d",
  b = "#8c541f",
}: { ink?: string; a?: string; b?: string } = {}): string {
  return LOGO_SVG.replaceAll("{ink}", ink).replaceAll("{a}", a).replaceAll("{b}", b);
}

/** `data:` URL for `<link rel="icon">` tags. */
export function logoDataUrl(colors?: Parameters<typeof logoSvg>[0]): string {
  return `data:image/svg+xml,${encodeURIComponent(logoSvg(colors))}`;
}
