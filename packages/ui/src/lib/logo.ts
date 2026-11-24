/**
 * The vibevarium mark — a mason-jar vibevarium with an acorn-rooted sprout
 * and amber code brackets — as a standalone SVG string, for favicons,
 * static HTML, and anywhere a React component won't do.
 *
 * `{ink}`, `{glass}`, `{bracket}` are literal placeholders, filled by
 * `logoSvg()` below (defaults are the Vellum light-mode inks).
 */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 138" fill="none"><rect x="30" y="6" width="60" height="13" rx="4" fill="{ink}"/><path d="M36 19v8c-7 7-13 11-13 25v45c0 13 9 21 26 21h22c17 0 26-8 26-21V52c0-14-6-18-13-25v-8" stroke="{ink}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M45 31h14M30 51c-2 4-2 8-2 11" stroke="{glass}" stroke-width="2.6" stroke-linecap="round"/><path d="M53 43l-9 8 9 8M67 43l9 8-9 8" stroke="{bracket}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M60 66v16" stroke="{ink}" stroke-width="5" stroke-linecap="round"/><path d="M60 82c-10 0-19-6-22-16 10 0 19 6 22 16z" fill="{ink}"/><path d="M60 82c10 0 19-6 22-16-10 0-19 6-22 16z" fill="{ink}"/><path d="M46 98c-6 0-11 3-14 9M38 99l-6-4M40 102l-2 7" stroke="{ink}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M74 98c6 0 11 3 14 9M82 99l6-4M80 102l2 7" stroke="{ink}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M60 94v-4" stroke="{ink}" stroke-width="4.5" stroke-linecap="round"/><path d="M50 95c0-8 4-11 10-11s10 3 10 11" stroke="{ink}" stroke-width="5" stroke-linecap="round"/><path d="M50 95h20v7c0 10-4.5 17.5-10 22.5-5.5-5-10-12.5-10-22.5v-7z" fill="{ink}"/><path d="M52 97h16" stroke="{glass}" stroke-width="2.4" stroke-linecap="round"/></svg>`;

/** Logo SVG with concrete colors. Defaults to the Vellum light-mode inks. */
export function logoSvg({
  ink = "#1e3120",
  glass = "#f7f7f1",
  bracket = "#c88439",
}: { ink?: string; glass?: string; bracket?: string } = {}): string {
  return LOGO_SVG.replaceAll("{ink}", ink).replaceAll("{glass}", glass).replaceAll("{bracket}", bracket);
}

/** `data:` URL for `<link rel="icon">` tags. */
export function logoDataUrl(colors?: Parameters<typeof logoSvg>[0]): string {
  return `data:image/svg+xml,${encodeURIComponent(logoSvg(colors))}`;
}
