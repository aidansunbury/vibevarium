# vibevarium — brand explorations

Work-in-progress brand directions. Preview everything side by side in
[concept-sheet.html](./concept-sheet.html) (open in a browser, or run the
dev server noted below).

The name is **vibevarium**: *vibe* + *-varium* (vibevarium / vivarium —
a contained living world). The product grows apps like plants in glass:
vibe-coded, self-contained ecosystems.

## Directions at a glance

| # | Name | Feel | Primary hue |
|---|------|------|-------------|
| A | Bioluminescent garden | Dark glass, glowing moss + amber | green/amber |
| B | Sunlit greenhouse | Warm cream, terracotta + leaf | terracotta/green |
| C | Neon vivarium | Near-black, electric lime + cyan | lime/cyan |
| D | Retro botanical print | Etched ink terracotta on cream | terracotta |
| E | Deep-sea vibevarium | Midnight teal, aqua glow | teal/cyan |

## Logo concepts (inline SVG, currentColor)

1. **Glass jar + circuit sprout** — apothecary bottle; a stem whose leaf is
   `</>`. The vibe-coding vibevarium.
2. **Monogram V** — a vibevarium jar silhouette that reads as the letter V,
   sprout stem inside, etched base line.
3. **Dome vibevarium** — geodesic dome with two leaves and a circuit-node
   root line. Geometric, engineered growth.
4. **Mason jar + code seed** — rounded jar, a seed that is also a terminal
   cursor. Friendlier, more organic.
5. **Bolt sprout** — a lightning bolt whose fork ends in two leaves.
   Most aggressive; "vibes at the speed of thought".
6. **Minimal pot + terminal leaf** — terracotta pot, one leaf shaped like a
   command-line prompt `>_`. Clean, iconic.

## Palettes

Each palette ships as drop-in values for `packages/ui/src/styles/globals.css`
(just the `:root` / `.dark` brand + accent vars).

### A — Bioluminescent garden
```
light:  --brand oklch(0.44 0.11 152)  moss
dark:   --brand oklch(0.80 0.17 152)  glow-moss
accents: sprout oklch(0.78 0.18 145) / nectar oklch(0.83 0.15 85)
```

### B — Sunlit greenhouse
```
light:  --brand oklch(0.53 0.17 45)   terracotta
dark:   --brand oklch(0.75 0.15 55)   lit-clay
accents: sage oklch(0.62 0.11 135) / gold oklch(0.80 0.12 90)
```

### C — Neon vivarium
```
light:  --brand oklch(0.52 0.19 140)  electric-leaf
dark:   --brand oklch(0.86 0.25 130)  neon-lime
accents: cyan oklch(0.85 0.13 195) / lime oklch(0.86 0.25 130)
```

### D — Retro botanical print
```
light:  --brand oklch(0.48 0.13 40)   etched-clay
dark:   --brand oklch(0.78 0.13 55)   lit-clay
accents: ink oklch(0.33 0.03 60) / moss oklch(0.55 0.10 140)
```

### E — Deep-sea vibevarium
```
light:  --brand oklch(0.52 0.10 200)  kelp
dark:   --brand oklch(0.83 0.12 190)  glow-aqua
accents: teal oklch(0.75 0.11 185) / cyan oklch(0.83 0.12 195)
```
