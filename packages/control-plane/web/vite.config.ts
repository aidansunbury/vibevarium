import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    port: 4101,
    proxy: {
      // Dev mode: the SPA calls the control plane's API through the vite proxy.
      "^/(apps|directory|discover|scaffold|integrations|connections|grants|proxy|whoami|mcp|health|auth|events)": {
        target: "http://127.0.0.1:4100",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
