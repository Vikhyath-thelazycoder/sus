import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin runs the Worker (src/worker) and serves the React app (index.html) together.
// Select the Wrangler environment with CLOUDFLARE_ENV=production at build time.
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
});
