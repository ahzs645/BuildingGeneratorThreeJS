# Vase comparison — remaining seam handoff

## Status

The Blender and GN-VM vase models are broadly aligned, but the GN-VM mesh still has a real, narrow outer-shell seam/interpenetration. It is most visible in close wireframe views near the rotational closure seam. This is **not fully resolved**.

Comparison page: `http://127.0.0.1:5173/vase?view=side-by-side`

Current generated asset (`public/dojo/vase_vm.json`):

- GN-VM: 101,212 vertices / 201,722 triangles
- Blender truth: 201,024 triangles

## Separate the valid feature from the defect

The center/bottom axial fan (which can look like a “bulb” or disk in wireframe) is valid geometry. Both Blender truth and GN-VM contain exactly 698 axial fan triangles. Do not delete this fan as a seam fix.

The actual defect is a narrow, blue outer-shell strip at the rotational seam. It appears to cross through the neighboring shell and runs nearly vertically along the vase.

## Current measurements

Run:

```sh
node --import tsx tools/mesh-surface-diff.ts --centroids
```

Current best result:

```text
truth 334776v 201024t
vm 101212v 201722t
truth axial fan triangles=698 z=[28.383,28.538] maxRadius=152.047
vm axial fan triangles=698 z=[28.155,28.189] maxRadius=151.096
truth points -> VM surface p50=0.067 p90=0.152 p99=0.682 max=3.683
VM points -> truth surface p50=0.068 p90=0.145 p99=1.680 max=13.979
VM component 1 (inner/cap):
  50955v 101559t
  centroid p99=0.176 max=0.865 outliers>2=0
VM component 2 (outer):
  50257v 100163t
  centroid p99=2.700 max=9.647 outliers>2=1233
  bounds=[51.045,-8.762,10.615]..[284.311,7.705,335.263]
```

The inner/cap component is close. The residual mismatch is concentrated in the outer component near `y = 0`, consistent with a rotational closure seam.

## Leading root-cause hypothesis

The rotational closure likely creates a winding/normal discontinuity, which a later normal-based offset turns into the visible interpenetration.

```text
Spin (349 steps; source profile has 149 vertices / wire edges)
  -> Merge By Distance
  -> Solidify N++ (Group.002; Thickness=0.1, Offset=1, Fill=true)
  -> root Set Position.001
       Selection: Group.002 Output_86 (outer branch only)
       Offset: Vector Math.009 * Normal.001 * Geometry Proximity
  -> DOJO Boolean.001 (FLOAT path)
```

Raw inspection found a seam vertex around `x=-192.65, y=0, z=40.33` with an inward-facing outer normal of roughly `[+0.8, 0, +0.6]`. Its neighboring angular vertices (`y≈±3.57`) had outward normals of roughly `[-0.799, ±0.022, -0.601]`.

The two angular sectors that close the Spin loop therefore appear to use reversed winding. Since `Set Position.001` offsets only the outer Solidify branch along its normal field, this bad normal drives the seam strip through adjacent geometry.

This is a strong hypothesis, not yet a completed fix.

## Current changes worth retaining

- `src/gnvm/nodes/meshops.ts`: Merge By Distance preserves faces that become valid triangles after consecutive duplicate vertices collapse. This retains the valid axial fan.
- `src/gnvm/geometry.ts`: export no longer filters the corresponding collapsed fan face. Its normal-cluster choice now prefers the outward cluster before population as a tiebreaker. This improved the metrics but did not fix the source topology.
- `src/vase-compare.ts`: comparison controls, no-cache asset loading, and camera-plane side-by-side separation. UI behavior is not the cause of the remaining geometry error.
- `tools/mesh-surface-diff.ts`: component, centroid, bounds, and axial-fan diagnostics via `--centroids`.

## Rejected approaches

| Attempt | Result |
| --- | --- |
| Delete collapsed fan faces | Incorrect; Blender truth has the same 698-triangle axial fan. |
| Force Boolean FLOAT to Manifold Exact CSG | Alters the envelope and substantially regresses surface comparison. |
| Replace normal clustering with ordinary averaged normals | Large global surface regression. |
| Globally orient faces after weld | Overcorrects open/solidify geometry and regresses dimensions. |
| Generic isolated winding-island cleanup | Changes valid Solidify output and regresses the result. |
| Prefer stored edge direction in EDGE Extrude | No measurable improvement for this vase. |
| Group-specific Spin winding repair | Overcorrected; removed. |
| Hardcoded triangle or position filtering | Not a general, maintainable fix. |

## Recommended next work

Fix winding at the topology source; do not add global cleanup.

1. Trace Spin immediately before and after Merge By Distance, retaining each face's orientation and source-edge provenance.
2. Add a small closed rotational-profile test for `GeometryNodeExtrudeMesh` in EDGE mode, including the final loop-closing edge.
3. Assert that the generated outer faces have a consistent outward orientation after merge.
4. Correct only the closure-face construction in Spin/EDGE Extrude.
5. Regenerate and compare the full vase.

Candidate acceptance criteria:

- Preserve exactly 698 axial fan triangles.
- Do not regress truth-to-VM `p99 <= 0.682`.
- Do not raise outer-component `outliers>2` above 1,233.
- Target an outer centroid `p99 < 2.700` and max `< 9.647`.
- Confirm that close wireframe orbit no longer shows the narrow blue strip crossing through the shell.

## Commands

Regenerate:

```sh
node --import tsx tools/gnvm-export.ts public/dojo/dump_bubble.json public/dojo/vase_vm.json 'BUBBLE VASE'
```

Validate:

```sh
npx tsx tools/gnvm-nodetest.ts
npm run build
git diff --check
node --import tsx tools/mesh-surface-diff.ts --centroids
```

Confirm mesh counts:

```sh
node --import tsx -e 'import fs from "node:fs"; const x = JSON.parse(fs.readFileSync("public/dojo/vase_vm.json", "utf8")); console.log(x.positions.length / 3, x.indices.length / 3)'
```

Expected current output: `101212 201722`.

## Key files

- `src/gnvm/nodes/meshops.ts` — Merge By Distance and EDGE Extrude.
- `src/gnvm/geometry.ts` — triangulation/export and normal clusters.
- `public/dojo/dump_bubble.json` — Blender node graph dump.
- `public/dojo/vase_vm.json` — generated comparison asset.
- `tools/gnvm-export.ts` — generator/export.
- `tools/mesh-surface-diff.ts` — diagnostics.
- `tools/gnvm-nodetest.ts` — regression tests.
- `src/vase-compare.ts` — viewer controls only, not the remaining geometry cause.
