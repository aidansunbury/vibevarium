import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4101,
    proxy: {
      // Dev mode: the SPA calls the control plane's API through the vite proxy.
      "^/(apps|directory|discover|scaffold|integrations|proxy|whoami|mcp|health|auth)": {
        target: "http://127.0.0.1:4100",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
