import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/** Where `npm run dev` should forward /api and /ws. */
const BACKEND = process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8002"

export default defineConfig({
  // Relative asset URLs. Behind the portal this app is served under `/p/<name>/`
  // and the proxy injects a `<base href>` -- which only steers RELATIVE urls, so
  // vite's default "/assets/index-*.js" would resolve against the portal root and
  // 404. Served directly, "./" resolves the same as before.
  base: "./",
  plugins: [react()],
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  server: {
    host: true,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/ws": { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  build: {
    // Served by the FastAPI app from backend/../frontend/dist.
    outDir: "dist",
    sourcemap: true,
    // Mantine and React are most of the bundle and both are needed on the
    // first paint. This is served over a local LAN, so splitting them out
    // would trade a fifth of a megabyte for a visible flash.
    chunkSizeWarningLimit: 700,
  },
})
