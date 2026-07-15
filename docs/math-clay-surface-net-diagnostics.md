# Math Clay surface-net diagnostics

This note records the July 2026 D-surface investigation. It deliberately does
not claim a connectivity fix: the evidence puts the first unresolved difference
before quad assembly.

## Reproduce

GN-VM polygon topology and surface-net counters:

```sh
npx tsx tools/math_clay_mesh_topology.ts public/dojo/math-clay/dump.json Dsurface
```

Blender evaluated polygon topology (the probe temporarily links asset-library
objects into the active view layer, which is required for Geometry Nodes to
evaluate instead of returning the 1,538-vertex seed mesh):

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  -b "/path/to/math clay download.blend" \
  -P tools/blender_math_clay_mesh_topology.py -- Dsurface
```

## D-surface evidence

| Measure | Blender | GN-VM |
| --- | ---: | ---: |
| Vertices | 35,054 | 35,054 |
| Quad faces | 35,052 | 33,540 |
| Unique edges | 70,104 | 67,572 |
| Boundary edges | 0 | 984 |
| Euler characteristic | 2 | 1,022 |

The GN-VM surface-net counters for its 71 x 71 x 71 sampled lattice are:

- 35,054 active cells, all with exactly one edge component;
- zero checkerboard/ambiguous cell faces;
- 33,540 crossed interior grid edges and 33,540 emitted quads;
- zero skipped quads from missing cell vertices or duplicate corners;
- zero vertices added by non-manifold fan splitting.

Therefore the 1,512-face gap is not caused by the current asymptotic-decider
branch, `addQuad` rejection, or fan splitting. The exact vertex-count match is
not sufficient evidence that Blender and GN-VM sampled the same scalar grid.
The GN-VM sign lattice itself requests only 33,540 dual-edge quads, while
Blender's evaluated OpenVDB result is a closed 35,052-quad manifold.

## Exact next experiment

Extract both scalar lattices before changing surface-net connectivity:

1. In a temporary Blender copy of `TPMS generator`, replace the selected
   `Dojo Field to Mesh` result with a point lattice at the Volume Cube sample
   coordinates and use Store Named Attribute to capture its incoming `FIELD`.
2. Dump the 67 x 67 x 67 stored Volume Cube values and, separately, the 71 x
   71 x 71 values/signs at Volume to Mesh's transformed lattice.
3. Add a GN-VM diagnostic export for the corresponding `VolumeGrid.values` and
   resampled grid, including origin, spacing, threshold, and a sign-bit hash.
4. Compare sign bits by coordinate and classify every differing crossed edge.
   Only if the sign grids match should the next change target OpenVDB's
   face-emission semantics. If they differ, fix Volume Cube field evaluation or
   GridTransformer sampling first.

No OpenVDB ambiguity/connectivity rule should be changed from the present
counts without that comparison, because seven of the thirteen Math Clay roots
are already topology-exact.

## Thirteen-root regression snapshot

The diagnostic-only change leaves all roots unchanged:

| Root object | Before | After |
| --- | ---: | ---: |
| Math Clay Study.003 | 23,968 / 23,966 | 23,968 / 23,966 |
| Math Clay Study.002 | 30,644 / 30,642 | 30,644 / 30,642 |
| Math Clay Study.008 | 17,061 / 28,525 | 17,061 / 28,525 |
| Math Clay Study.006 | 29,226 / 29,226 | 29,226 / 29,226 |
| Math Clay Study.007 | 108,958 / 108,924 | 108,958 / 108,924 |
| Math Clay Study.014 | 129,503 / 125,916 | 129,503 / 125,916 |
| Math Clay Study.018 | 42,770 / 42,768 | 42,770 / 42,768 |
| Math Clay Study.019 | 133,373 / 128,394 | 133,373 / 128,394 |
| Math Clay Study.013 | 85,696 / 86,010 | 85,696 / 86,010 |
| Math Clay Study.001 | 14,887 / 25,665 | 14,887 / 25,665 |
| Math Clay Study.004 | 35,200 / 35,198 | 35,200 / 35,198 |
| Math Clay Study.005 | 61,098 / 61,124 | 61,098 / 61,124 |
| Dsurface | 35,054 / 33,540 | 35,054 / 33,540 |

Counts are vertices / polygon faces from `runGenerator`; the seven exact roots
remain exact.
