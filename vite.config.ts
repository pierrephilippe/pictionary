import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    // Source maps are useful locally but add more than 1 MB of public assets
    // to every Cloudflare deployment. Production errors are already logged by
    // the Worker with structured context.
    sourcemap: false,
  },
});
