import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "src/client",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
});
