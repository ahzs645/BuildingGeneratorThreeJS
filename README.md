# BuildingGeneratorThreeJS

The Blender-like Geometry Nodes workspace vertical slice is available at `/crayon`. See [docs/GEOMETRY_NODES_WORKSPACE.md](docs/GEOMETRY_NODES_WORKSPACE.md) for its semantic contract, reference/license review, and schema migration path.

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

## Geometry Nodes studio

The studio is the app's root: open `http://127.0.0.1:5173/` while the dev server
is running (`/blendbridge` redirects there). A persistent navigation bar sits at
the top of every page: it shows the current section and tool, links to the sibling
tools of that section, and opens the full tool directory via the `PS` mark, the
**All tools** button, or <kbd>⌘K</kbd>. You
can drop in a `.blend` file, choose either a Geometry Nodes modifier or a reusable
asset-only node group, edit its graph and exposed inputs, preview it in Three.js,
and export the edited portable graph JSON. Asset groups can be seeded with a cube,
plane, curve, or an extracted object and can expose multiple geometry inputs and
outputs. The bundled bin graph is available from **Try included bin sample**.

Extraction is intentionally local-first: the Vite middleware opens Blender in
background mode, returns the node/material dump, then removes the temporary `.blend`
copy. Plain, Gzip-compressed, and Zstandard-compressed Blender files are accepted.
Set `BLENDER_BIN` if Blender is not installed at the standard macOS path. Evaluation
runs in a replaceable Web Worker, debounces graph changes for 250 ms, reports
queued/running/error/ready state, and keeps the previous valid geometry visible if
an edit fails. Extracted graph JSON is portable and can be re-imported without
opening Blender again.

The No3d Tools import/evaluation contract and current compatibility gaps are tracked
in [docs/NO3D_TOOLS_PIPELINE.md](docs/NO3D_TOOLS_PIPELINE.md).

The static production bundle contains the studio UI and runtime, but direct `.blend`
extraction still needs the local Vite middleware (or a future hosted Blender worker).

The interface is a single Vite + React application. Routes such as `/building`,
`/paint`, `/gallery`, `/bin`, and `/vase` lazy-load their Three.js runtimes from
one HTML bootstrap. Previous `.html` URLs redirect to the corresponding React
route, as do the retired `/vegetation-generator`, `/geometry-painter`, and
`/surface-draw` routes.

`/paint` is the unified Surface Painting Studio. Its procedural engine (Three.js
WebGPU, `src/surface-painter`) hosts every stroke-driven generator behind one
option set — surface-painted, wind-reactive ivy; the interactive banyan tree with
flower/fig brushes; and crystal veins, molten fissures, aurora silk, and
bioluminescent reef colonies — all with shared model presets, local GLB uploads,
model scaling, and the studio bloom pipeline. The generator implementations and
their MIT licenses remain under `src/vegetation-generator` and
`src/geometry-painter` (runtime assets under `public/vegetation`). Its second
engine, the Blender brush lab (`/paint?engine=blender`), evaluates
Blender-authored brushes (Chrome Crayon, Periodic Brush) through the GN-VM along
a stroke projected onto an uploaded mesh, with fixed Blender parity paths.
Pen strokes remain editable source curves: select and move a whole stroke or an
individual control point and the combined drawing re-evaluates through Chrome
Crayon, preserving proximity/merge interaction between crossings on flat and
local curved-surface patches. The reusable authoring and backend-adapter
contract is documented in
[`docs/EDITABLE_CURVE_FRAMEWORK.md`](docs/EDITABLE_CURVE_FRAMEWORK.md).

`/bin` is the synchronized Dojo Bin parity workspace: one Bin Select control
drives a baked Blender-truth variant and a fresh GN-VM evaluation, with overlay,
side-by-side, wire/material, triangle, highlighted-material, and envelope-delta
comparisons. The former standalone `/gnvm` page redirects into this workspace.

`/crayon` includes the Blender-like Geometry Nodes workspace for the extracted
Chrome Crayon graph. It preserves authored groups, frames, reroutes, socket order,
and stable socket identifiers; readable output-chain framing, full-screen authoring,
cross-group search, selection, breadcrumbs, minimap, wiring,
value edits, and undo/redo are connected to the existing GN-VM Web Worker and
Three.js parity viewport. Architecture, reference-project licensing, and the
Tree Clipper metadata migration plan are documented in
[`docs/GEOMETRY_NODES_WORKSPACE.md`](docs/GEOMETRY_NODES_WORKSPACE.md).

## GitHub Pages

Pushing `main` deploys the static React studio through
`.github/workflows/deploy-pages.yml`. The workflow runs the GN-VM regression suite,
builds with the repository-specific Vite base path, installs an SPA fallback, and
publishes `dist` through GitHub Pages. In repository settings, set **Pages → Source**
to **GitHub Actions** once if Pages has not previously been enabled.

GitHub Pages can run the gallery, baked generators, GN-VM, comparison tools, and
previously extracted graph JSON. Direct `.blend` extraction and the Blender-backed
live bin still require the local services because Pages is static hosting.

For the live Blender bin locally, run the warm Blender evaluator and its HTTP
bridge alongside Vite (replace the `.blend` path if the source is elsewhere):

First stage locally recovered fonts. The command validates them against the
checked-in parity hashes and stores them under the gitignored `.local-assets/`
directory; unrecognized cuts are retained as candidates but are not loaded as
exact Blender truth:

```sh
npm run bin:stage-fonts -- /path/to/dogica.otf "/path/to/Degular Text Semibold.ttf"
```

```sh
blender --background "/path/to/Dojo Bin Generator_recursive red bins_v.0.1.1.blend" \
  --python tools/bake_server.py -- /tmp/bin-bake-comm "Procedural Drawer"
node tools/bake-bridge.mjs /tmp/bin-bake-comm 7801
```

Then open `/bin/live`. The `/bin` comparison does not need those services: its
Blender side uses 12 checked-in truth bakes while GN-VM evaluates live.

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
