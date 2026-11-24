# @vibevarium/ui

The Vibevarium design system: [shadcn/ui](https://ui.shadcn.com) component
patterns built on [Base UI](https://base-ui.com) primitives (`@base-ui/react`,
re-exported as `@base-ui-components/react`), with a Tailwind CSS v4 theme. It
is consumed by the control-plane GUI (`packages/control-plane/web`) and by
every generated app template (`packages/template-cloudflare/web`).

Following the shadcn philosophy, **the components are source you own** — they
live in `src/components/` as real `.tsx` files, copied into this repo rather
than installed as a black-box dependency. Edit them freely; that's the point.

## Layout

```
src/
├── styles/globals.css   # Tailwind v4 theme: CSS variables (light + dark) + @theme inline
├── lib/
│   ├── utils.ts         # cn() — clsx + tailwind-merge
│   ├── icons.ts         # lucide-react re-exports (apps depend only on @vibevarium/ui)
│   └── toast.ts         # sonner `toast` re-export
├── components/          # shadcn-style components on Base UI primitives
│   ├── button.tsx  card.tsx  input.tsx  label.tsx  badge.tsx  table.tsx
│   ├── dialog.tsx  dropdown-menu.tsx  select.tsx  tabs.tsx  separator.tsx
│   └── sonner.tsx       # <Toaster /> toast host
└── layout/shell.tsx     # <Shell> header + content container (sidebar-ready)
```

## Using it

A web package depends on it as a `file:` link (the web packages are isolated
pnpm installs, not workspace members — see "Package wiring" below):

```jsonc
// package.json
{
  "dependencies": {
    "@vibevarium/ui": "file:../../ui",
    "tailwindcss": "^4",
    "@tailwindcss/vite": "^4",
    "react": "^19",
    "react-dom": "^19"
  }
}
```

```ts
// vite.config.ts
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({ plugins: [react(), tailwindcss()] });
```

```css
/* src/index.css — one line pulls in the whole theme */
@import "@vibevarium/ui/styles.css";
```

```tsx
import { Button } from "@vibevarium/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@vibevarium/ui/components/card";
import { Shell, ShellBody, ShellHeader } from "@vibevarium/ui/layout/shell";
import { Toaster } from "@vibevarium/ui/components/sonner";
import { toast } from "@vibevarium/ui/lib/toast";
```

> **Import icons and `toast` from `@vibevarium/ui`, not directly.** The web
> packages install only `@vibevarium/ui`; `lucide-react` and `sonner` are its
> transitive deps and aren't resolvable from app code (pnpm isolation). Add an
> icon to `src/lib/icons.ts` when you need a new one.

## Adding a component (the shadcn + Base UI flow)

The components come from the shadcn registry's **Base UI** variant (the
`base-nova` style). To add a new one:

1. **Fetch the Base UI source** for the component, not the Radix one. The
   registry path is:

   ```
   https://ui.shadcn.com/r/styles/base-nova/<component>.json
   ```

   The JSON has `files[].content` — the `.tsx` source. (The Radix variant at
   `/r/styles/new-york-v4/...` imports `radix-ui`; you want the one importing
   `@base-ui/react/<part>`.)

2. **Copy the source into `src/components/<component>.tsx`** and adapt it:
   - Point `cn` at the local helper: `import { cn } from "../lib/utils"`.
   - Replace the registry's `IconPlaceholder` with real icons from
     `lucide-react` (and re-export the icon from `src/lib/icons.ts`).
   - The registry uses the `cn` *npm package*; we use the classic
     `cn()` built on `clsx` + `tailwind-merge` (the task's standard set) — same
     call signature, so the component bodies are unchanged.
   - Registry-only helpers it references (`cn-menu-target`,
     `cn-menu-translucent`, `cn-font-heading`, …) are shadcn-site-internal; drop
     them or map them onto our theme variables.

3. **Export and use.** The package `exports` map already exposes
   `./components/*`, so `@vibevarium/ui/components/<component>` works with no
   manifest change. Then reinstall the consumers (see below) so the new file is
   linked into their `node_modules`.

4. If the component needs a new Base UI part or a new dependency, add it to
   `packages/ui/package.json` `dependencies` and reinstall.

### Reinstall after editing

The web packages consume `@vibevarium/ui` via a `file:` dependency, which pnpm
**hardlinks** into their `node_modules` at install time. Edits to *existing*
files show up immediately (same inode), but **new files require a reinstall**
of each consumer:

```sh
pnpm --dir packages/control-plane/web install --ignore-workspace --force
pnpm --dir packages/template-cloudflare/web install --ignore-workspace --force
```

`--ignore-workspace` keeps the install scoped to that package's own lockfile;
`--force` re-links the `file:` dep.

## Theming

All color lives in CSS variables defined in `src/styles/globals.css`, in
`oklch`, for **light (`:root`)** and **dark (`.dark`)** modes. Toggle dark mode
by putting `class="dark"` on `<html>`.

| Variable | Purpose |
| --- | --- |
| `--background` / `--foreground` | page background / default text |
| `--card` / `--card-foreground` | card surfaces |
| `--popover` / `--popover-foreground` | menus, dialogs, toasts |
| `--primary` / `--primary-foreground` | primary action color (derives from `--brand`) |
| `--secondary`, `--muted`, `--accent` (+`-foreground`) | supporting surfaces |
| `--destructive` (+`-foreground`) | danger |
| `--border`, `--input`, `--ring` | borders, input borders, focus ring |
| `--radius` | base corner radius (sm/md/lg/xl derive from it) |
| **`--brand`** / **`--brand-foreground`** | **the re-theme hook** |

### Re-theming a fork

`--primary` is defined as `var(--brand)`, so **overriding `--brand` re-brands
every primary button, link, and focus accent** — same spirit as the
customizable CLI name. A fork overrides variables *after* importing the theme,
in its own `index.css`:

```css
@import "@vibevarium/ui/styles.css";

:root {
  /* brand teal */
  --brand: oklch(0.6 0.12 195);
  --brand-foreground: oklch(0.98 0 0);
}
.dark {
  --brand: oklch(0.7 0.12 195);
}
```

No component edits needed. Override more variables (or `--radius`) for a
deeper re-skin.

## Package wiring (why `file:` and not `workspace:*`)

`packages/control-plane/web` and `packages/template-cloudflare/web` are
**isolated pnpm installs** with their own committed `pnpm-lock.yaml`, not
members of the root workspace (the root `pnpm-workspace.yaml` only covers
`packages/*` and `apps/*` top-level). `workspace:*` only links between
workspace members, so it can't reach these nested web packages. A `file:../../ui`
dependency inlined into each web lockfile is the mechanism that works here —
that's why the consumers install with `--ignore-workspace`.

`packages/ui` declares both `@base-ui-components/react` (the current package
name, per the platform decision) and `@base-ui/react` (the name the shadcn
Base UI registry sources import). They are the same code; the registry
imports resolve through the latter.

## Conventions

- **React 19**, **Tailwind v4** (vite plugin — no `tailwind.config.js`; the
  theme is the CSS file via `@theme inline`).
- Components are unstyled-by-default Base UI primitives wrapped with cva
  variants + `cn()`. Keep them thin; variant logic lives in the cva call.
- No custom fonts beyond the system stack, no component libraries beyond the
  standard set: `clsx`, `tailwind-merge`, `class-variance-authority`,
  `lucide-react`, `sonner`, Base UI.
