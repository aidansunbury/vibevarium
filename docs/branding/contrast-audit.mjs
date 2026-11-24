// WCAG 2.x contrast audit for the botanical palette candidates.
// oklch(L C h) -> oklab -> linear sRGB -> relative luminance -> contrast ratio.

function oklchToOklab([L, C, h]) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  return [L, a, b];
}
function oklabToLinearSrgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function luminance(oklch) {
  const [r, g, b] = oklabToLinearSrgb(oklchToOklab(oklch));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b; // linear-light luminance
}
const contrast = (x, y) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = (oklch) =>
  "#" + oklabToLinearSrgb(oklchToOklab(oklch)).map((c) => Math.round(Math.min(1, Math.max(0, toSrgb(c))) * 255).toString(16).padStart(2, "0")).join("");

// Colors as [L, C, h]; alpha composites over a background.
const over = (fg, alpha, bg) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));

const PALETTES = {
  cream: {
    light: { bg:[.95,.03,100], fg:[.30,.04,120], card:[.975,.025,100], muted:[.46,.03,112], line:[.30,.04,120,.52], primary:[.46,.12,148], onPrimary:[.97,.02,100], a:[.46,.12,148], b:[.48,.13,40] },
    dark:  { bg:[.24,.008,110], fg:[.93,.015,105], card:[.285,.01,110], muted:[.76,.015,110], line:[.93,.015,105,.45], primary:[.78,.13,145], onPrimary:[.22,.04,145], a:[.78,.13,145], b:[.76,.12,65] },
  },
  vellum: {
    light: { bg:[.975,.008,110], fg:[.27,.03,130], card:[.99,.006,110], muted:[.44,.025,125], line:[.27,.03,130,.52], primary:[.42,.11,152], onPrimary:[.98,.008,110], a:[.42,.11,152], b:[.50,.10,60] },
    dark:  { bg:[.235,.006,240], fg:[.94,.008,140], card:[.28,.008,240], muted:[.76,.01,180], line:[.94,.008,140,.50], primary:[.80,.12,155], onPrimary:[.20,.03,160], a:[.80,.12,155], b:[.78,.10,90] },
  },
  sage: {
    light: { bg:[.90,.035,128], fg:[.28,.045,140], card:[.955,.02,125], muted:[.44,.035,135], line:[.28,.045,140,.52], primary:[.40,.11,150], onPrimary:[.97,.02,125], a:[.40,.11,150], b:[.50,.11,55] },
    dark:  { bg:[.25,.006,120], fg:[.92,.015,115], card:[.30,.008,120], muted:[.75,.015,120], line:[.92,.015,115,.52], primary:[.76,.13,148], onPrimary:[.21,.04,148], a:[.76,.13,148], b:[.75,.11,70] },
  },
};

const toColor = (arr, surface) => (arr.length === 4 ? over(arr.slice(0, 3), arr[3], surface) : arr);

const AA = { normal: 4.5, large: 3.0 };
const AAA = { normal: 7.0, large: 4.5 };
const NONTEXT = 3.0; // WCAG 1.4.11 non-text (icons, input borders)

function verdict(ratio, size /* "normal"|"large" */, target = "AA") {
  const need = target === "AA" ? AA[size] : AAA[size];
  return { pass: ratio >= need, need };
}

let failures = 0;
for (const [pname, modes] of Object.entries(PALETTES)) {
  console.log(`\n=== ${pname.toUpperCase()} ===`);
  for (const [mode, c] of Object.entries(modes)) {
    console.log(`  [${mode}]`);
    const pairs = [
      // name, fg-color, bg-surface, size, min target (AA|AAA), category
      ["body text (fg / bg)",        c.fg,        c.bg,   "normal", "AA"],
      ["body text (fg / card)",      c.fg,        c.card, "normal", "AA"],
      ["headings (fg / bg)",         c.fg,        c.bg,   "large",  "AA"],
      ["muted text (muted / bg)",    c.muted,     c.bg,   "normal", "AA"],
      ["muted text (muted / card)",  c.muted,     c.card, "normal", "AA"],
      ["primary btn (onPrimary / primary)", c.onPrimary, c.primary, "normal", "AA"],
      ["ghost btn text (fg / bg)",   c.fg,        c.bg,   "normal", "AA"],
      ["badge 'open' (a / card)",    c.a,         c.card, "normal", "AA"],
      ["accent b ornament (b / bg)", c.b,         c.bg,   "large",  "AA"],
      ["-- UI component borders --", null, null, null, null],
      ["input/ghost border (line / bg)",  c.line, c.bg,   "ui", null],
      ["input border (line / card)",      c.line, c.card, "ui", null],
      ["badge outline (a / card)",        c.a,    c.card, "ui", null],
      ["-- wordmark accents on logo --", null, null, null, null],
      ["logo ink (fg / bg)",         c.fg,        c.bg,   "ui", null],
    ];
    for (const [name, fg, bg, size, target] of pairs) {
      if (fg === null) { console.log(`    ${name}`); continue; }
      const surface = bg.slice(0, 3);
      const fgc = toColor(fg, surface);
      const bgc = toColor(bg, surface);
      const r = contrast(fgc, bgc);
      let mark, need;
      if (size === "ui") {
        mark = r >= NONTEXT ? "PASS" : "FAIL";
        need = NONTEXT.toFixed(1);
      } else {
        const v = verdict(r, size, target);
        mark = v.pass ? "PASS" : "FAIL";
        need = v.need.toFixed(1);
        if (v.pass) {
          const v3 = verdict(r, size, "AAA");
          if (v3.pass) mark = "PASS·AAA";
        }
      }
      if (mark === "FAIL") failures++;
      console.log(`    ${mark.padEnd(9)} ${r.toFixed(2).padStart(5)} (need ${need})  ${name}  ${hex(fgc)} on ${hex(bgc)}`);
    }
  }
}
console.log(`\n${failures === 0 ? "✔ all checks pass" : `✘ ${failures} check(s) fail`} (AA normal 4.5, AA large 3.0, UI/non-text 3.0)`);
