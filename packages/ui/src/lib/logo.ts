/**
 * The vibevarium mark — a mason-jar terrarium with an acorn-rooted sprout
 * and amber code brackets — as a standalone SVG string, for favicons,
 * static HTML, and anywhere a React component won't do.
 *
 * `{ink}`, `{glass}`, `{bracket}` are literal placeholders, filled by
 * `logoSvg()` below (defaults are the Vellum light-mode inks).
 */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 138" fill="none"><rect x="27" y="4" width="66" height="14" rx="5" fill="{ink}"/><path d="M34 20v6c-7 6-15 10-15 25v50c0 14 10 22 28 22h26c18 0 28-8 28-22V51c0-15-8-19-15-25v-6" stroke="{ink}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 31h18M74 31h3" stroke="{glass}" stroke-width="3" stroke-linecap="round"/><path d="M28 49c-3 4-3 9-3 14M25 68v3" stroke="{glass}" stroke-width="3" stroke-linecap="round"/><path d="M54 42l-9 8 9 8M66 42l9 8-9 8" stroke="{bracket}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M60 66V80" stroke="{ink}" stroke-width="4.5" stroke-linecap="round"/><path d="M60 82C51 82 42 77 38 68c9 0 17 5 22 14z" fill="{ink}"/><path d="M60 82c9 0 18-5 22-14-9 0-17 5-22 14z" fill="{ink}"/><path d="M46 104c-7 0-12 3-16 9M37 105l-6-4M40 107l-3 7" stroke="{ink}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M74 104c7 0 12 3 16 9M83 105l6-4M80 107l3 7" stroke="{ink}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M52 98v-6c0-8 3.5-11 8-11s8 3 8 11v6" stroke="{ink}" stroke-width="4.5" stroke-linecap="round"/><path d="M60 98h14v6c0 11-6 19-14 25z" fill="{ink}"/><path d="M46 98h28v6c0 11-6 19-14 25-8-6-14-14-14-25v-6z" stroke="{ink}" stroke-width="4.5" stroke-linejoin="round"/></svg>`;

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
