import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

// The built SPA is served by the same Worker that hosts the Api: asset
// requests hit Cloudflare's asset layer, and every API path is routed
// worker-first (see `assets.runWorkerFirst` in src/TicketsWorker.ts).
// In dev, `alchemy dev` runs the Worker on :1337 (workerd, real DOs + D1)
// and vite proxies the API paths to it, so the frontend has hot reload
// against the real domain runtime.
const apiProxyTarget = process.env.TICKETS_API_ORIGIN ?? "http://localhost:1337";

const apiPaths = [
  "/OpenTicket",
  "/CloseTicket",
  "/TicketById",
  "/TicketList",
  "/openapi.json",
  "/rpc",
  "/mcp",
  "/whoami",
  "/auth",
  "/d1-health",
];

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(apiPaths.map((path) => [path, apiProxyTarget])),
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
