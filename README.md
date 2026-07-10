# BuildingGeneratorThreeJS

A procedural Hong Kong building generator for Three.js, ported from a Blender
geometry-nodes setup (`procedural-hong-kong-building/source/procedural_building.blend`).
Original model URL : https://sketchfab.com/3d-models/procedural-hong-kong-building-528a732e84c44fd49c4726f341014a23

The original 592-node "build system" node group was reverse-engineered into a
TypeScript placement algorithm ([docs/BUILD_SYSTEM.md](docs/BUILD_SYSTEM.md)); the
~190 building parts (walls, windows, AC units, clotheslines, storefronts, roof props…)
are exported from the .blend into a single instanced asset kit
(`public/assets/kit.glb` + `kit_manifest.json`).

## Run

```sh
npm install
npm run dev
```

All 18 generator parameters from the Blender modifier (floors, footprint, AC/clothline/
lights probabilities, window type & open amount, curtains, store state, seed, low-poly
toggle…) are exposed as live sliders.

## BlendBridge Geometry Nodes studio

Open `http://127.0.0.1:5173/blend-import.html` while the dev server is running. You
can drop in a `.blend` file, choose a Geometry Nodes modifier, edit its exposed
inputs, build a Three.js preview, and export either the extracted graph JSON or the
evaluated mesh JSON. The bundled bin graph is available from **Try the bin sample**.

Extraction is intentionally local-first: the Vite middleware opens Blender in
background mode, returns the node/material dump, then removes the temporary `.blend`
copy. Set `BLENDER_BIN` if Blender is not installed at the standard macOS path.
Evaluation runs in a killable Web Worker with a three-minute timeout, so a slow or
unsupported graph cannot lock the interface. Extracted graph JSON is portable and
can be re-imported without opening Blender again.

The static production bundle contains the studio UI and runtime, but direct `.blend`
extraction still needs the local Vite middleware (or a future hosted Blender worker).

## Re-exporting the asset kit

If you edit assets in the .blend, re-run the export (Blender 4.2+):

```sh
blender --background procedural-hong-kong-building/source/procedural_building.blend \
        --python tools/export_kit.py -- public/assets/kit.glb public/assets/kit_manifest.json
```

## Structure

- `src/generator.ts` — the ported node graph: grids, seeded RNG, placements
- `src/kit.ts` — GLB kit loader + InstancedMesh builder
- `src/rng.ts` — Blender-style hash(id, seed) random values
- `src/main.ts` — scene, lighting, lil-gui controls
- `tools/` — Blender headless scripts (kit export, node-graph dump)
