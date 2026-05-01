import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@gpt-image-canvas/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url))
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: ['.monkeycode-ai.online'],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        timeout: 600000,
        proxyTimeout: 600000
      }
    }
  }
});
