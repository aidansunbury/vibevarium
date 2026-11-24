# @vibevarium/video

Remotion promo for [vibevarium](https://vibevarium.com) — a ~40 second,
1080p30 piece in the botanical-print brand language (Fraunces display,
IBM Plex Mono data, Graphite dark palette, hairline + double rules,
laid-paper grain).

## Scenes

| # | Scene | Beat |
|---|-------|------|
| I | `Seed` | An acorn drops, is sealed in a glass jar terrarium |
| II | `Command` | `vibevarium grow ledger` scaffolds repo, worker, D1, auth, domain |
| III | `Tree` | The sprout becomes a tree of app parts — every app self-contained |
| IV | `Garden` | Camera pulls back to a shelf of glowing jars |
| V | `Control` | Light field-guide interlude: the gardener's ledger at platform.vibevarium.com |
| VI | `Keys` | One OIDC platform token unlocks the gateway and every app |
| VII | `Wordmark` | vibevarium — *grown, not built* |

## Commands

```sh
pnpm studio        # Remotion Studio
pnpm build         # render out/video.mp4
pnpm render:gif    # 15fps 960px gif for docs/social
```

The logo mark is inlined from `docs/branding/logo.svg` as
`src/components/LogoMark.tsx` with per-part progress props
(`jar`, `brackets`, `sprout`, `acorn`) so scenes can grow it piecemeal.
