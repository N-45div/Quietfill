import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, requests to /fcc/* are forwarded to the extension proxy so the
// browser never fights CORS locally. In production either serve the app
// behind the same host as the proxy, or add CORS headers at the tunnel
// (e.g. ngrok --response-header-add "Access-Control-Allow-Origin: *").
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/fcc": {
        target: process.env.FCC_PROXY_URL ?? "http://localhost:6674",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/fcc/, ""),
      },
    },
  },
});
