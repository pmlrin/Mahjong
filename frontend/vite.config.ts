import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Dev-only: point the proxy at a backend on another port when 3000 is taken.
const api = `http://127.0.0.1:${process.env.MJ_API_PORT ?? 3000}`;
export default defineConfig({
  root: "frontend",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": api,
      "/socket.io": { target: api, ws: true },
    },
  },
});
