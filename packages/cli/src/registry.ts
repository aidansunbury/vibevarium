/**
 * Registry of domain-package Apis embedded in the published binary.
 *
 * A bun-compiled single binary has no node_modules and cannot `import()` a
 * bare package specifier at runtime (there is nothing to resolve it against),
 * so the dynamic CLI cannot load an arbitrary tarball's Api directly. Instead
 * the platform's known domain Apis are statically imported here at build time;
 * `apps add` records which registry key an app uses, and the loader picks the
 * embedded module.
 *
 * This keeps the published binary self-contained while the manifest still
 * decides which apps are exposed and where they live. When the app registry
 * moves to the control plane, this map becomes a fetched manifest + lazy
 * per-app bundles rather than a static import list.
 */
import { TicketsApi } from "@vibevarium/template/TicketsApi.api";
import type { Cliable } from "@alchemy.run/domain/Cli";

/**
 * Maps a domain package's published specifier to its embedded Api modules.
 * Keyed by npm package name; each entry exposes that package's Apis by class
 * name. Add an import + entry here when a new app joins the platform release.
 */
export const embeddedApis: Readonly<Record<string, Readonly<Record<string, Cliable>>>> = {
  "@vibevarium/template": { TicketsApi },
};
