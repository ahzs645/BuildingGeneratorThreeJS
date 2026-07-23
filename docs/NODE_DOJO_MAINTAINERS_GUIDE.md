# Node Dojo Blender-to-browser parity maintainers' guide

Last reconciled with the repository: 2026-07-23.

This is the entry point for maintaining the Node Dojo Geometry Nodes port. It
documents the execution path, the 101-entry live catalog, the evidence standard,
and the remaining qualified residuals. Asset-specific measurements remain
authoritative in the colocated JSON reports under
[`public/dojo/`](../public/dojo/); this guide explains how to read and reproduce
them.

Related focused documents:

- [`node-dojo-inventory.md`](node-dojo-inventory.md) records all active roots in
  the 16 supplied Blender projects, including roots that are deliberately not
  catalog products.
- [`node-dojo-roadmap.md`](node-dojo-roadmap.md) is the detailed porting history
  and asset-by-asset narrative.
- [`node-dojo-course-audit.md`](node-dojo-course-audit.md) explains why 176
  course roots become 13 published course entries rather than 176 products.
- [`node-dojo-font-audit.md`](node-dojo-font-audit.md) records the font source
  and distribution decisions.
- [`GEOMETRY_NODES_WORKSPACE.md`](GEOMETRY_NODES_WORKSPACE.md) documents the
  graph editor's projection of the same dump schema.
- [`MATERIALX_SHADER_PARITY.md`](MATERIALX_SHADER_PARITY.md) and
  [`MATERIALX_DEPENDENCIES.md`](MATERIALX_DEPENDENCIES.md) cover the separate
  MaterialX investigation.

## What is authoritative

Use evidence in this order:

1. The supplied `.blend` evaluated in the recorded Blender version, object,
   frame, transform context, and modifier overrides.
2. A durable machine-readable Blender reference, parameter sweep, render
   metadata file, or mesh export committed under `public/dojo/`.
3. The asset's `status.json` and any `*-parity.json` or `*-comparison.json`
   beside it.
4. The catalog entry in
   [`public/dojo/chrome-assets/catalog.json`](../public/dojo/chrome-assets/catalog.json).
5. Narrative documents, which summarize but do not replace the evidence above.

Do not promote a recollected count, an interactive screenshot, or “it looks
right” to a parity claim. A Blender result is meaningful only with its evaluation
contract. Frame-dependent course caches, local versus authored object transforms,
dependency cycles, downstream non-GN modifiers, and instance realization have
all changed observed outputs in this repository.

The old [`NODE_DOJO_PARITY_AUDIT.md`](NODE_DOJO_PARITY_AUDIT.md) remains useful
as a dated investigation log. Later status files, material reports, and the
resolved [`VASE_SEAM_HANDOFF.md`](VASE_SEAM_HANDOFF.md) supersede its earlier
measurements where they conflict.

## Architecture and data flow

```text
supplied .blend
    │  Blender background process + tools/dump_blend.py
    ▼
portable dump JSON
    │  selected object, node closure, base/evaluated dependencies,
    │  materials, images/fonts where permitted, provenance metadata
    ▼
GN-VM Web Worker
    │  runGenerator() → dependency ordering → node/field evaluation
    │  → Geometry → indexed triangle soup + attributes/material groups
    ▼
Three.js BufferGeometry + browser material reconstruction
    │
    ▼
WebGL comparison viewport and durable capture
```

### 1. Source projects and Blender extraction

The source pack is external to the repository. Project IDs and relative source
paths are declared in
[`tools/node-dojo-projects.json`](../tools/node-dojo-projects.json), and
[`tools/materialx/run_node_dojo_blender.mjs`](../tools/materialx/run_node_dojo_blender.mjs)
resolves them beneath `NODE_DOJO_PACK_ROOT`. Blender is an external authoring,
extraction, and reference-rendering tool.

[`tools/dump_blend.py`](../tools/dump_blend.py) serializes the Blender RNA state
needed by GN-VM:

- objects, transforms, source meshes/curves, modifiers, and modifier input
  values;
- node groups, interface sockets, nodes, ordered links, frames, reroutes, and
  zone metadata;
- referenced objects, collections, materials, shader groups, images, fonts, and
  evaluated dependency snapshots where the extraction policy permits them;
- `extraction_metadata` containing schema/extractor/Blender versions, the source
  SHA-256 fingerprint, document-local IDs, typed dependency descriptors,
  provenance, and cycle/frozen-snapshot warnings.

Pass a target object whenever possible. Targeted extraction limits large mesh,
image, UV, collection, and dependency payloads to the reachable closure. The
runtime still accepts older dumps without `extraction_metadata`; typed
descriptors are authoritative when present and `dependency_objects` is the
legacy fallback. See
[`src/gnvm/dependency-metadata.ts`](../src/gnvm/dependency-metadata.ts) and the
schema notes in
[`GEOMETRY_NODES_WORKSPACE.md`](GEOMETRY_NODES_WORKSPACE.md#current-extraction-schema).

The `/blendbridge` local-import route uses the same extractor through
[`tools/vite-blend-import.ts`](../tools/vite-blend-import.ts). It:

- accepts a valid `.blend` up to 1 GiB;
- runs Blender for at most ten minutes;
- writes the upload and `dump.json` to a unique temporary directory;
- adds transient import metadata to the response;
- removes the temporary directory in a `finally` block.

This endpoint exists only in the local Vite/preview server. A static deployment
can load a previously extracted JSON file but cannot open a `.blend`.

### 2. Dump JSON as the portable contract

The dump is both the editor document and the runtime program. It is not
translated into a second graph format before evaluation. Stable Blender socket
identifiers take precedence over duplicate human-readable socket names. The
editor adapter in
[`src/geometry-nodes/graph-model.ts`](../src/geometry-nodes/graph-model.ts)
projects the dump without repairing or mutating it.

Important boundaries:

- The dump is an extracted observation, not a Blender round-trip format.
- An evaluated dependency snapshot is allowed only when its provenance is
  explicit. It must not be described as a procedurally reproduced final asset.
- Missing images/fonts and dependency-cycle edges are observable source states.
  Preserve or qualify them rather than silently inventing data.
- A graph with 100% registered node-type coverage can still be numerically or
  topologically wrong. Coverage is a prerequisite, not parity evidence.

### 3. GN-VM Worker evaluation

Both the asset library and BlendBridge create a module Worker from
[`src/blend-import-worker.ts`](../src/blend-import-worker.ts). The Worker calls
[`runGenerator`](../src/gnvm/index.ts), which:

1. loads the Manifold and Bullet-hull WASM backends;
2. resets per-evaluation dump, frame, dependency, and missing-handler state;
3. resolves and evaluates reachable object dependencies before the requested
   root while guarding cycles;
4. binds modifier defaults by socket identifier, applies named overrides, and
   injects the object's pre-modifier geometry into the Geometry input;
5. evaluates groups, fields, geometry components, repeats, and instances through
   [`Evaluator`](../src/gnvm/evaluator.ts) and the handlers under
   [`src/gnvm/nodes/`](../src/gnvm/nodes/);
6. converts the result to indexed triangle soup with normals, optional
   corner-normal/provenance arrays, named attributes, line components, material
   groups, and counts.

Typed-array buffers are transferred, not cloned, back to the main thread.
BlendBridge gives an evaluation 180 seconds and lets the user terminate the
Worker. The catalog creates a fresh Worker for an evaluation and terminates it
after the reply. Expensive evaluation therefore cannot block the UI thread, but
it can still consume a worker core and memory until it finishes or is
terminated.

### 4. Three.js and WebGL presentation

The main thread maps the soup to `THREE.BufferGeometry`, preserves index groups
and named attributes, and selects one material per group. The simple import
studio reconstructs dumped Principled and Emission inputs in
[`src/blend-import.ts`](../src/blend-import.ts). The 101-asset comparison page
uses the more specific material dispatch in
[`src/chrome-assets.ts`](../src/chrome-assets.ts), with reusable implementations
such as:

- [`filament-material.ts`](../src/filament-material.ts) and
  [`cross-section-filament-material.ts`](../src/cross-section-filament-material.ts);
- [`chrome-crayon-material.ts`](../src/chrome-crayon-material.ts);
- [`attribute-emission-material.ts`](../src/attribute-emission-material.ts);
- [`packed-sticker-material.ts`](../src/packed-sticker-material.ts);
- [`node-base-material.ts`](../src/node-base-material.ts).

`Normalized`/diagnostic material is intentionally separate from `Authored`.
Diagnostic mode helps compare silhouettes and normals; it is not evidence that
the authored shader has been reproduced.

## The 101-entry catalog

[`public/dojo/chrome-assets/catalog.json`](../public/dojo/chrome-assets/catalog.json)
is the canonical live catalog. Its current 101 entries group as follows:

| Maintainer-facing family | Entries | Canonical supporting inventory/status |
| --- | ---: | --- |
| Chrome assets, including Periodic Brush and 2.5D Chrome Crayon | 27 | [`public/dojo/chrome-assets/`](../public/dojo/chrome-assets/) |
| N03D 3D-printing utilities | 28 | [`public/dojo/n03d/root-classification.json`](../public/dojo/n03d/root-classification.json) |
| New Joint generators | 4 | [`public/dojo/joints/`](../public/dojo/joints/) |
| Math Clay surfaces | 13 | [`public/dojo/math-clay/status.json`](../public/dojo/math-clay/status.json) |
| The Nodes Node | 12 | [`public/dojo/nodes-node/status.json`](../public/dojo/nodes-node/status.json) |
| Send Nodes Hat | 4 | [`public/dojo/send-nodes-hat/status.json`](../public/dojo/send-nodes-hat/status.json) |
| Course modules | 13 | [`public/dojo/course-audit/status.json`](../public/dojo/course-audit/status.json) |
| **Total** | **101** | |

Catalog entries are presentation/evidence units, not a count of all Blender
objects or all unique root graphs:

- several entries can share one dump;
- one root can represent multiple saved object users or equivalent presets;
- a curve/wire helper can be a valid zero-face catalog entry;
- a course scene can contain many incremental lesson snapshots but publish only
  distinct visible studies;
- empty, passthrough, duplicated, stacked, or source-placeholder roots stay in
  classification reports rather than becoming misleading products.

The complete source inventory is 499 active modifiers and 291 project-local root
families across 16 projects. Keep the catalog count and source inventory count
separate.

## Parity terminology

Every parity adjective must name or inherit a scope. Do not use bare “exact” to
combine unrelated geometry, material, renderer, and dependency claims.

| Term | Required meaning |
| --- | --- |
| Handler coverage | Every reachable node type has a registered runtime handler. This says nothing by itself about numeric correctness. |
| Count parity | The compared representations have the same vertex/face/triangle counts. Counts alone do not prove the same surface. |
| Exact topology | The stated Blender polygon or exported-triangle topology matches at the stated cases. The report must say whether it also proves face/index ordering, winding, edge sets, or only counts/connectivity. |
| Bounds exact / four-decimal bounds | Bounds match at the stated precision. This is not pointwise or surface equality. |
| Surface-export parity | Blender's polygons and GN-VM's triangles represent the same measured surface even when polygon counts differ; for example Bubble Putty is 4,675 Blender polygons and 6,608 exported triangles. |
| Exact geometry | The report explicitly proves its chosen topology, coordinate/bounds, material-allocation, and parameter-sweep contract. Do not infer renderer identity. |
| Near parity | A disclosed, quantified residual remains. Record direction, units, tolerance, cases, and evidence file. |
| Material semantics parity | Material ownership, attributes, constants, coordinate spaces, and relevant procedural fields match the extracted graph. |
| Renderer near parity | Eevee/Workbench and Three.js/WebGL remain different renderers; pixel metrics quantify their aligned result without claiming identity. |
| Native-equivalent OpenVDB race | The deterministic browser result is inside the observed range of repeated native OpenVDB/Blender results and the field/sampling contract has been independently checked. It is not byte-identical snapshot parity. |

Use “structurally exact” only when the status file defines what structure was
measured. Use “visual parity” only with a committed comparison and explicit
limits; a screenshot by itself is not a metric.

## Geometry parity methodology

### Establish the Blender contract

Record:

- source project ID and source fingerprint;
- Blender version;
- object and root group;
- frame and whether the supplied cached frame or a forced frame is intended;
- authored-world versus identity/local-space evaluation;
- modifier values and parameter cases;
- whether only the first GN modifier or the complete modifier stack is in scope;
- whether instances are realized and whether curves/lines are expected to
  produce a mesh surface;
- dependency substitutions, frozen evaluated meshes, or graph routes used only
  for a diagnostic probe.

[`tools/render_blender_reference.py`](../tools/render_blender_reference.py) and
[`tools/parity_sweep.py`](../tools/parity_sweep.py) encode these choices through
arguments and `NODE_DOJO_*` environment variables. Store those settings in the
resulting JSON rather than only in shell history.

### Compare progressively

Use the least ambiguous test that can disprove parity:

1. missing handler and evaluation errors;
2. vertices, Blender polygons, exported triangles, and line/curve counts;
3. local bounds with full precision retained in the evidence;
4. polygon-size histogram, edge set, components, boundaries, manifoldness,
   winding, and material-face allocation when relevant;
5. direct index/face order and coordinate comparison when an exact contract
   requires it;
6. bidirectional point-to-triangle and centroid-to-triangle surface distances
   when triangulation or Boolean partitioning differs;
7. meaningful parameter sweeps, including switches, low/high resolutions,
   degenerate values, and dependency-sensitive modes;
8. repeat and cold-process runs for suspected native nondeterminism.

[`tools/gnvm-sweep.ts`](../tools/gnvm-sweep.ts) runs the browser cases that pair
with Blender's sweep. [`tools/mesh-surface-diff.ts`](../tools/mesh-surface-diff.ts)
performs the bidirectional surface comparison used by the vase work. Probe
intermediate sockets only to isolate a cause; the final claim still needs a
root-output test.

Blender polygons and browser triangles must not be compared under the same
`faces` label without explaining the representation. When a catalog entry has
both, use `blenderStats.faces` for Blender polygons and
`blenderStats.triangles` for the expected exported triangle count.

## Material and renderer parity methodology

Geometry must be stable before tuning an authored material. Otherwise camera
mask and luminance differences conflate two bugs.

The material workflow is:

1. Verify evaluated material slots/groups, face allocation, named attributes,
   UVs, generated/object/window coordinates, flat/smooth state, sharp edges,
   and split/corner normals.
2. Extract the active Blender material graph and constants from the dump.
3. Implement the smallest asset-family recognizer or reusable material that
   preserves those semantics. Do not silently replace a missing texture or
   unsupported branch with aesthetically pleasing artwork.
4. Render the evaluated Blender object with
   [`tools/render_blender_reference.py`](../tools/render_blender_reference.py).
   The shared capture is 768 × 768, orthographic, transparent, and can select
   Workbench or Eevee, local-space evaluation, an authored frame, a frozen
   evaluated mesh, the shared studio environment, and controlled lights.
5. Run the built app and capture the matching catalog asset with
   [`tools/capture_authored_asset.mjs`](../tools/capture_authored_asset.mjs).
   It uses a 768 × 768, device-pixel-ratio-1 headless Chrome canvas, waits for
   the page's readiness marker, supports control overrides and multisample
   accumulation, and fails on browser errors.
6. Compare the transparent Blender image against the browser's segmentation-key
   background with
   [`tools/compare_stippler_shader_masks.py`](../tools/compare_stippler_shader_masks.py).

Record at least silhouette IoU (plus one-pixel coverage for thin geometry),
pixel and macro luminance MAE, mean luminance delta, and correlation when the
signal has enough variance for correlation to be meaningful. Explain which
metric controls acceptance. A nearly constant white shader can have a useful
low MAE and an ill-conditioned correlation.

The comparison intentionally separates:

- geometry/camera alignment;
- material ownership and scalar/procedural semantics;
- renderer-specific lighting, environment filtering, tone mapping,
  derivatives, raster coverage, and antialiasing.

MaterialX is an additional backend experiment, not a blanket replacement for
the authored material dispatch. The backend fallback contract is defined in
[`src/material-backend.ts`](../src/material-backend.ts).

## Blender reference, browser capture, and comparison commands

Install the pinned JavaScript dependencies first:

```sh
npm ci
```

Run the local application:

```sh
npm run dev
```

Extract one targeted object from a known source project:

```sh
NODE_DOJO_PACK_ROOT="/path/to/extracted/node-dojo-pack" \
node tools/materialx/run_node_dojo_blender.mjs <project-id> \
  tools/dump_blend.py -- \
  public/dojo/<family>/<asset>/dump.json "<Blender object name>"
```

Validate typed dependencies and optionally evaluate the dump:

```sh
node --import tsx tools/validate_dump_dependencies.ts \
  public/dojo/<family>/<asset>/dump.json "<Blender object name>" --evaluate
```

Create a browser tri-soup:

```sh
node --import tsx tools/gnvm-export.ts \
  public/dojo/<family>/<asset>/dump.json \
  /tmp/<asset>-gnvm.json "<Blender object name>" '{"Control":1}'
```

Run paired parameter sweeps:

```sh
NODE_DOJO_PACK_ROOT="/path/to/extracted/node-dojo-pack" \
node tools/materialx/run_node_dojo_blender.mjs <project-id> \
  tools/parity_sweep.py -- \
  /tmp/<asset>-blender-sweep.json /tmp/<asset>-blender-meshes \
  "<Blender object name>" tools/<asset>-parity-cases.json

node --import tsx tools/gnvm-sweep.ts \
  public/dojo/<family>/<asset>/dump.json \
  /tmp/<asset>-gnvm-sweep.json \
  /tmp/<asset>-blender-sweep.json /tmp/<asset>-gnvm-meshes \
  "<Blender object name>" tools/<asset>-parity-cases.json
```

Render one isolated Blender reference:

```sh
NODE_DOJO_PACK_ROOT="/path/to/extracted/node-dojo-pack" \
NODE_DOJO_GN_ONLY=1 NODE_DOJO_AUTHORED_MATERIAL=1 \
node tools/materialx/run_node_dojo_blender.mjs <project-id> \
  tools/render_blender_reference.py -- \
  "<Blender object name>" \
  public/dojo/references/<family>/<asset>-authored.png \
  public/dojo/references/<family>/<asset>-authored.json LOCAL
```

Build, serve, and capture the matching browser view:

```sh
npm run build
npm run preview -- --host 127.0.0.1

node tools/capture_authored_asset.mjs \
  http://127.0.0.1:4173 <catalog-id> \
  public/dojo/references/<family>/<asset>-authored-webgl.png \
  1 authored
```

Compare the aligned renders:

```sh
NODE_DOJO_PACK_ROOT="/path/to/extracted/node-dojo-pack" \
node tools/materialx/run_node_dojo_blender.mjs <project-id> \
  tools/compare_stippler_shader_masks.py -- \
  public/dojo/references/<family>/<asset>-authored.png \
  public/dojo/references/<family>/<asset>-authored-webgl.png \
  public/dojo/<family>/<asset>/material-comparison.json
```

Use a family-specific capture orchestrator when one exists, such as
[`tools/capture_math_clay_materials.mjs`](../tools/capture_math_clay_materials.mjs)
or
[`tools/capture_nodes_node_materials.mjs`](../tools/capture_nodes_node_materials.mjs).
These preserve non-default environment, frame, dependency-freeze, sample-count,
and light-scale settings in the aggregate report.

Run the repository gates:

```sh
npm test
npm run build
node --import tsx tools/gnvm-nodetest.ts
node --import tsx tools/audit-dojo-catalog-evidence.ts
git diff --check
```

The evidence audit checks all 101 entries for dumps, references, colocated
status records, catalog/status count contradictions, invalid/missing durable
paths, and ephemeral `/private/tmp` references.

## Evidence file conventions

Use lower-case stable slugs. Keep generated evidence with the product it
describes:

```text
public/dojo/<family>/<asset>/
    dump.json                       portable runtime input
    status.json                     current geometry/coverage/residual summary
    material-parity.json            authored material contract and interpretation
    material-comparison.json        raw aligned image metrics

public/dojo/references/<family>/
    <asset>.png                     isolated Blender diagnostic reference
    <asset>-authored.png            Blender authored-material reference
    <asset>-authored.json           Blender render/evaluation metadata
    <asset>-authored-webgl.png      browser capture

tools/<asset>-parity-cases.json      named modifier override cases
```

Shared families may use one `status.json` with a `variants` array and one dump
for several catalog IDs. Aggregate reports such as
[`public/dojo/math-clay/material-parity-all.json`](../public/dojo/math-clay/material-parity-all.json)
may summarize variants, but each catalog ID must still resolve to the correct
status record.

Conventions:

- Repository paths in JSON must be durable and repository-relative. Do not
  commit `/tmp`, `/private/tmp`, a home directory, or a mounted-drive path.
- Put source project/object/root/version/overrides and capture configuration in
  JSON metadata.
- Keep Blender polygons and exported triangles in separately named fields.
- Keep raw metrics numeric; put interpretation and accepted residuals in a
  sibling text field.
- `status.json` is current state, not a chronological diary. Move investigation
  history into `docs/` when it is useful.
- Catalog notes should be concise reader-facing summaries of the status, not
  the only place a limitation is recorded.
- Do not hand-edit a reference image to improve metrics.

## Fonts, textures, external dependencies, and licensing

### Fonts

The current policy is recorded in
[`node-dojo-font-audit.md`](node-dojo-font-audit.md):

- `pixels.ttf` and `DejaVuSans-ExtraLight.ttf` are the published, reviewed font
  binaries under [`public/dojo/fonts/`](../public/dojo/fonts/). The DejaVu
  license is committed beside the binary.
- Blurmed, Degular, Dogica, and Brokenscript recovered binaries remain external;
  portable Blender-extracted polygon outlines may be stored in dumps, but the
  binaries are not published.
- Bodoni Poster, Eurostile Bold Extended, and Caslon Black remain unavailable.
- Text Soup and Type Pixel Brush use a documented Pixels substitution in both
  Blender and GN-VM because their original fonts are absent. This supports a
  matched substitution claim, not original-font parity.

When adding a font, record its exact source, hash, license, whether the binary
may be redistributed, and which glyphs/variants were validated. Apply the same
substitution to Blender truth and the browser. Never compare one font against a
different fallback and call the geometry exact.

### Textures and environments

[`public/dojo/chrome-assets/textures/manifest.json`](../public/dojo/chrome-assets/textures/manifest.json)
maps six packed Chrome-asset images to their extracted files and explicitly
records two missing images. The Flat Stickie Pack reproduces Blender's magenta
missing-image diagnostic for those missing files; it does not invent them.

The Conveyor Mechanic lightbulb maps are packed Blender images from a Poly Haven
CC0 asset. Their provenance and extraction tool are recorded in
[`public/dojo/n03d/conveyor-mechanic/textures/SOURCE.json`](../public/dojo/n03d/conveyor-mechanic/textures/SOURCE.json).

The shared Blender `studio.exr` environment is stored as base64 and described by
[`public/dojo/blender-studio-environment.json`](../public/dojo/blender-studio-environment.json).
Its reproduced CC0 notice is
[`public/dojo/LICENSE-blender-studio.txt`](../public/dojo/LICENSE-blender-studio.txt).

The Send Nodes Hat bill/front remains material-source-blocked by six absent
fabric images and one absent logo PSD; the exact list is in
[`public/dojo/send-nodes-hat/material-parity.json`](../public/dojo/send-nodes-hat/material-parity.json).
Geometry parity does not remove that material limitation.

### External code and source projects

Three.js is an npm MIT dependency; Blender is invoked externally and no Blender
GPL source is copied into the runtime. The MaterialX dependency and notice
policy is documented separately in
[`MATERIALX_DEPENDENCIES.md`](MATERIALX_DEPENDENCIES.md).

The repository's root MIT license does not by itself establish redistribution
rights for every supplied `.blend`, font, texture, logo, reference render, or
generated derivative. Preserve per-asset provenance and notices, and require a
license review before publishing a new third-party binary. Unknown,
noncommercial, GPL, or absent licensing is a boundary for copying/distribution,
not permission to silently vendor an implementation.

## OpenVDB nondeterminism

Some Blender volume results are not stable count or topology snapshots even
with identical fields and inputs. Parallel OpenVDB intersection-tree scheduling
has produced multiple valid results in repeated same-session, cold-process, and
concurrent runs.

Two current examples:

- Math Clay `TPMS.016`: GN-VM is 87,095 / 85,386; ten Blender 5.1.2 same-session
  runs ranged from 87,095 / 85,386 to 87,101 / 85,392, and six runs landed
  exactly on GN-VM. The full field is value-exact and the browser result is
  labeled `native-equivalent-openvdb-race`, not snapshot-exact. See
  [`public/dojo/math-clay/status.json`](../public/dojo/math-clay/status.json).
- N03D Watertight Bolt: the deterministic 13-pass browser result is
  16,226 / 16,228, while ten sequential Blender results ranged from 16,526 to
  16,598 vertices. The one-pass browser topology exactly matches one observed
  Blender schedule and 131,278 of 131,279 controlled SDF signs match. See
  [`public/dojo/n03d/bolt-watertight/status.json`](../public/dojo/n03d/bolt-watertight/status.json).

For an OpenVDB claim:

1. prove the scalar/vector field, transform, lattice, isovalue, and sign
   classification separately;
2. repeat native evaluation in the same process and in cold processes;
3. record the observed range and concurrency conditions;
4. compare closedness, bounds, surface distance, and topology distributions,
   not only one count;
5. keep GN-VM deterministic;
6. use `native-equivalent-openvdb-race` only when the deterministic result is
   supported by the observed native range and field evidence.

Do not chase one stored native count by adding nondeterminism or
asset-coordinate exceptions to the browser.

## Filament shaders are not slicing or G-code

Many N03D and Joint assets contain materials or groups named `Filament`,
`PRINT VIZ`, layer height, cross section, split to print, or print bed. In the
current repository these are authored viewport behaviors:

- procedural Wave/Noise/Bump bands that resemble printed layers;
- front/back color or emission branches;
- material and named-attribute visualization;
- optional design-mesh cuts, part separation, or cross-section inspection;
- build-bed presentation.

They do **not** establish:

- sliced layer contours;
- nozzle centerlines or travel moves;
- extrusion width/flow, speeds, temperatures, retractions, supports, infill, or
  seam planning;
- printer-specific G-code;
- printability or manufacturing validation.

The browser material implementations change shading, not the generated design
mesh. A future slicer/toolpath feature must produce and validate a separate
derived artifact with its own units, printer/profile provenance, and comparison
method. Never label a filament viewport capture as toolpath or G-code parity.

## Current known residuals

The 101 catalog entries all have a dump, reference, and status record, and every
represented reusable root/distinct course study satisfies the repository's
publication evidence standard. “Catalog closure” does not mean every result is
bit-identical or every source dependency exists.

### Geometry and evaluation

- **N03D Watertight Bolt:** deterministic browser topology differs from the
  stored 13-pass Blender snapshot by about 2.08%; native Blender/OpenVDB itself
  varies. This remains quantified visual/native-equivalent near parity.
- **Math Clay TPMS.016:** four vertices/faces below the stored reference, but
  inside repeated native OpenVDB ranges. Broader parameter validation remains
  useful; there is no evidence of a default-field defect.
- **Three-Way Pipe cutter mode:** exact bounds and zero sampled
  Blender-to-browser surface distance, but the browser open-surface Boolean
  retains one small inner patch with 0.1911% area overhead after reciprocal
  open-shell cycles are filtered. Default and five non-cutter variants are
  exact.
- **Accepted small bounds/float residuals:** examples include the Procedural Box
  max-X difference of 0.000001907, Stackable Bin bounds within 0.0004, Course
  Intro Room Stage B's 0.0017 legacy curve-frame bound residual, and the Node
  Dojo emblem's 0.0000745 bound residual. Their status files define the accepted
  scope; do not upgrade those labels to bit-exact coordinates.
- **Recursive Bin historical baseline:** the July audit records surface and
  topology differences, while the newer
  [`bin-material-parity.json`](../public/dojo/bin-material-parity.json) proves
  matching total/highlight triangle counts across `Bin Select` 0–11. There is
  no newer durable full parameter surface sweep that supersedes every old
  geometry measurement. Re-baseline it before making a current exact-geometry
  claim.
- **Bubble Vase:** the former seam, cut, cap, and timeout findings are resolved
  at the current checkpoint: 100,514 vertices/polygons and 201,024 exported
  triangles on both sides, with p99 surface distance 0.001. See
  [`VASE_SEAM_HANDOFF.md`](VASE_SEAM_HANDOFF.md).

### Materials, rasterization, and missing data

- Chrome reflection, filament high-frequency bump, Workbench cavity/light, and
  Eevee-versus-Three.js raster/filter differences remain renderer residuals on
  many assets even where geometry and material semantics are exact.
- Image Pixel Stippler is geometry-exact, while the best durable authored
  capture still records 0.0395 binary-mask disagreement and 0.9683 pixel
  correlation; exact shader pixels are not claimed.
- Text Soup geometry is exact for all five Pixels-substituted cases. Its full
  surface-only authored comparison reaches 0.962625 silhouette IoU and
  0.386-pixel corner RMSE. Its exact 156-segment guide remains available through
  the viewport control; remaining differences are reflection/raster filtering,
  and the original nine fonts are missing.
- 3D Chrome Crayon Generator geometry is exact across all six recovered-font
  cases. Its `mesh` framing mode retains Blender's unreferenced evaluated mesh
  vertices while excluding the separate loose guide, reaching 0.920131
  silhouette IoU, 0.0937-pixel corner RMSE, and 0.991061 macro luminance
  correlation. The remaining residual is `flat.nodes` color interpolation and
  raster coverage.
- Nodes Node UI assets retain small glyph-position and Workbench
  lighting/cavity differences despite topology-and-bounds closure.
- Hat bill/front exact material parity is blocked by seven missing external
  images. Embroidery geometry is exact and its material comparison is
  quantified separately.
- Flat Stickie and Print Bed Previewer preserve the supplied missing-image
  behavior. Recovering and licensing the original image would require new
  Blender/browser evidence rather than silently replacing the current truth.

### Source/scope limitations

- Knit Graphic has Geometry Node groups but no active GN modifier.
- Dusty Crystal Cocoon's active node modifiers are Auto Smooth; its authored
  result appears baked or driven outside the active GN path.
- The course's 113 incremental instructional snapshots and 16 helpers are
  classified but intentionally not duplicated as products.
- Several commercial or unavailable fonts remain external/source-limited.

## Adding and validating a new asset

1. **Inventory and deduplicate.** Identify the exact source project, object,
   modifier, root, distinct visible behavior, duplicate users, and helpers.
   Update the relevant machine-readable classification rather than publishing a
   duplicate preset as a product.
2. **Review dependencies and licensing first.** List object/collection pointers,
   fonts, images, materials, source libraries, licenses, absent files, and
   dependency cycles. Decide what may be embedded or published before extracting
   binaries.
3. **Define the evaluation contract.** Pin Blender version, frame, transforms,
   GN-only versus full modifier stack, instance realization, dependency policy,
   and meaningful default/edge parameter cases.
4. **Extract a targeted dump.** Use `tools/dump_blend.py` with the object name.
   Check `extraction_metadata`, the source fingerprint, warnings, typed
   dependencies, payload size, and whether any personal/temporary paths leaked.
5. **Validate dependencies and coverage.** Run
   `validate_dump_dependencies.ts --evaluate`; inspect missing handlers and
   confirm base/evaluated dependency geometry is intentional.
6. **Create Blender truth and GN-VM sweeps.** Compare counts and full-precision
   local bounds for every case. Add topology, attributes, material allocation,
   surface distance, and intermediate probes in proportion to ambiguity.
7. **Fix shared semantics, not asset coordinates.** Add focused node/regression
   tests for every runtime correction. Avoid asset-ID, object-name, or
   coordinate-window exceptions unless they encode a documented source
   contract that cannot be generalized.
8. **Capture authored material evidence separately.** First prove geometry and
   camera alignment, then material ownership/fields, then renderer metrics.
   Record all non-default environment, light, tone-map, sample, frame, font, and
   freeze settings.
9. **Add durable evidence.** Add/update the dump, Blender reference, browser
   capture, metadata, comparison report, `status.json`, parity cases, and
   catalog entry. Keep every limitation in `status.json`; mirror only a concise
   summary into the catalog note.
10. **Audit reader controls.** Expose only controls that change Blender's
    evaluated result in the supplied contract. Mark workbench/authored/diagnostic
    modes honestly, and label filament previews as non-slicer output.
11. **Run all gates.** Tests, build, GN-VM node tests, dependency validation,
    catalog evidence audit, browser capture with no warnings/errors, and
    `git diff --check` must pass.
12. **State the acceptance scope.** Use the terminology above and list every
    residual with units, cases, metrics, and evidence paths.

## Completion checklist

The parity/documentation work is complete only when all checked items are true:

- [ ] `public/dojo/chrome-assets/catalog.json` contains the intended unique
  product/evidence entries, and family/root classifications explain every
  omitted duplicate, helper, placeholder, or non-surface root.
- [ ] Every catalog entry resolves to an existing dump, Blender reference,
  matching status record, and durable evidence paths.
- [ ] `node --import tsx tools/audit-dojo-catalog-evidence.ts` reports zero
  errors.
- [ ] Every dump records source/extractor provenance and has no unexplained
  missing dependency or ephemeral absolute path.
- [ ] Every published root has 100% reachable handler coverage and a successful
  browser evaluation.
- [ ] Geometry claims cover default plus meaningful parameter cases and state
  whether they prove counts, connectivity, face/index order, coordinates,
  bounds, surface, materials, attributes, curves/lines, and dependencies.
- [ ] Blender polygons and browser/export triangles are labeled separately.
- [ ] Suspected OpenVDB results have repeated native ranges and field/lattice
  evidence; no single nondeterministic count is called the universal truth.
- [ ] Authored material evidence separates graph/attribute semantics from
  renderer pixels and records capture configuration plus quantitative metrics.
- [ ] Missing fonts/textures and all substitutions are identical on both sides,
  disclosed, and license-reviewed.
- [ ] Viewport filament/print visualization is never described as slicing,
  toolpath, printability, or G-code parity.
- [ ] Known residuals remain in the current `status.json` and reader-facing
  catalog note with a concrete reproduction path.
- [ ] Shared runtime fixes have focused regression tests.
- [ ] `npm test`, `npm run build`, `tools/gnvm-nodetest.ts`, relevant
  asset/dependency checks, capture scripts, and `git diff --check` pass.
- [ ] This guide, the inventory, roadmap, course/font audits, and any historical
  handoff notes link to the current machine-readable evidence rather than
  carrying contradictory current counts.
