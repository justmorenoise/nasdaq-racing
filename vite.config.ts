import { defineConfig } from "vite";

export default defineConfig({
  // Percorsi relativi: la build viene servita anche da una sottocartella
  // (l'embed su morenoise.it sta sotto /embeds/nasdaq-racing/), dove gli
  // asset referenziati come /assets/… non esisterebbero.
  base: "./",
  server: {
    host: true,
    port: 5173,
  },
  build: {
    chunkSizeWarningLimit: 600, // pixi.js is legitimately ~510kB on its own
    rollupOptions: {
      output: {
        // Split the big vendors into their own chunks for caching + smaller
        // initial parse.
        manualChunks: {
          pixi: ["pixi.js"],
          supabase: ["@supabase/supabase-js"],
        },
      },
    },
  },
});
