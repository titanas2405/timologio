import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Το frontend ζει στο web/. Σε ανάπτυξη ο Vite (5173) προωθεί το /api στον Fastify (3000).
// Σε παραγωγή το build πάει στο dist/web και το σερβίρει ο ίδιος ο Fastify.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
