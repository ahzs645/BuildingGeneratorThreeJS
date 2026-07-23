# Bubble Vase — resolved Blender parity checkpoint

## Status

The browser GN-VM now reproduces the supplied Blender `BUBBLE VASE` output at
exact topology and near-float-exact surface parity.

Comparison page: `http://127.0.0.1:5173/vase?view=side-by-side`

| Output | Vertices | Polygons | Exported triangles |
| --- | ---: | ---: | ---: |
| Blender 5.1.2 | 100,514 | 100,514 | 201,024 |
| GN-VM | 100,514 | 100,514 | 201,024 |

Both polygon-size histograms are identical:

```text
triangles=698 quads=99814 350-gons=1 352-gons=1
```

The 698-triangle center/bottom axial fan is authored geometry and is present in
both results. It is not a seam artifact.

## Surface validation

Run:

```sh
node --import tsx tools/mesh-surface-diff.ts \
  public/dojo/vase_truth.glb public/dojo/vase_vm.json --centroids
```

Current checkpoint:

```text
truth triangles=201024
vm triangles=201024
truth axial fan=698 z=[28.383,28.538] maxRadius=152.047
vm axial fan=698 z=[28.383,28.538] maxRadius=152.047
truth points -> VM surface p50=0 p90=0 p99=0.001 max=0.001
VM points -> truth surface p50=0 p90=0 p99=0.001 max=0.001
centroid p99=0.001 in both directions
centroid outliers > 2 units=0
```

The approximately 0.3-unit worst centroid delta is confined to alternate
triangulation of the same planar n-gon cap. It does not represent a different
surface or envelope.

## Root causes fixed

Four independent semantic differences compounded into the earlier seam and
extra-ring result:

1. **Capture Attribute lifetime** — repeat evaluation created a new anonymous
   attribute on every iteration and retained every array. Expanded nodes now
   have stable identity, with two rolling repeat epochs so the previous state
   remains readable without unbounded memory growth.
2. **EDGE Extrude winding** — the endpoint special case alternated the winding
   of side faces while spinning an open profile. New strips now inherit the
   consistently reversed direction of their selected source edge. All 51,303
   Spin faces match Blender's cyclic orientation.
3. **Boolean face-selection adaptation** — a final FACE boolean field was
   averaged to POINT and then treated as truthy. Blender uses boolean AND for
   this conversion. The corrected conversion selects exactly 50,955 outer
   points and excludes the 349 boundary points.
4. **FLOAT box intersection** — the fallback removed whole faces crossing a
   cutter plane. A one-plane polygon clip now creates the exact boundary and
   cap loops, while an enclosing AABB is recognized as a topology-preserving
   no-op.

These are general GN-VM semantics rather than vase-specific coordinate filters.

## Regression coverage

- Stable anonymous capture identity and bounded rolling repeat captures.
- Boolean POINT/FACE conversion using Blender's AND rule.
- Repeated open-profile EDGE extrusion with consistent winding.
- FLOAT one-plane clipping of an annular shell with attributes.
- FLOAT intersection with an enclosing box preserving topology and attributes.
- Exact final vase topology and bidirectional surface-distance comparison.

## Reproduce

```sh
node --import tsx tools/gnvm-export.ts \
  public/dojo/dump_bubble.json public/dojo/vase_vm.json 'BUBBLE VASE'

node --import tsx tools/mesh-surface-diff.ts \
  public/dojo/vase_truth.glb public/dojo/vase_vm.json --centroids

node --test --import tsx \
  src/gnvm/boolean-provenance.test.ts \
  src/gnvm/capture-domain.test.ts \
  src/gnvm/extrude-mesh.test.ts

npm test
npm run build
node --import tsx tools/gnvm-nodetest.ts
node --import tsx tools/audit-dojo-catalog-evidence.ts
git diff --check
```

Blender intermediate probes used to isolate the branches are recorded in
`tools/vase-probe-specs.json`.

## Key files

- `src/gnvm/evaluator.ts` — expanded-node scope and rolling repeat epochs.
- `src/gnvm/nodes/geometry.ts` — Capture Attribute and boolean field adaptation.
- `src/gnvm/nodes/meshops.ts` — EDGE Extrude winding.
- `src/gnvm/nodes/extra.ts` — FLOAT AABB intersection clipping.
- `public/dojo/dump_bubble.json` — extracted Blender graph.
- `public/dojo/vase_vm.json` — generated browser output.
- `tools/mesh-surface-diff.ts` — bidirectional surface diagnostics.
- `tools/vase-probe-specs.json` — Blender intermediate probe definitions.
