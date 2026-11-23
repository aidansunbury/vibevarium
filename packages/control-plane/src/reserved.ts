/**
 * Reserved app names: the platform's own control surface is exposed to agents
 * under the `control` alias (control_* MCP tools, the `control` CLI subtree).
 * A fleet app named `control` would collide with that surface, so scaffold,
 * provision, and app-registration routes all reject it.
 */
export const RESERVED_APP_NAME = "control";

export const isReservedAppName = (name: string) => name === RESERVED_APP_NAME;
