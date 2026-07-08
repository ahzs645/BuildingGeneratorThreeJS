import { defineConfig } from "vite";

// Multi-page app: each HTML file is a build entry so `vite build` emits them all.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: "index.html", // landing / studio home
        building: "building.html", // Hong Kong building (hand-ported)
        dojo: "dojo-viewer.html", // baked bin (GLB)
        gnvm: "gnvm-viewer.html", // live geometry-nodes VM
      },
    },
  },
});
