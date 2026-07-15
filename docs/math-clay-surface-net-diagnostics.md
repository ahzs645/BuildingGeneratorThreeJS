# Math Clay surface-net diagnostics

This note records the July 2026 D-surface investigation and its resolved
negative-boundary topology defect.

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
| Quad faces | 35,052 | 35,052 |
| Unique edges | 70,104 | 70,104 |
| Boundary edges | 0 | 0 |
| Euler characteristic | 2 | 2 |

The fixed GN-VM surface-net counters for its 71 x 71 x 71 sampled lattice are:

- 35,054 active cells, all with exactly one edge component;
- zero checkerboard/ambiguous cell faces;
- 35,052 crossed grid edges and 35,052 emitted quads;
- zero skipped quads from missing cell vertices or duplicate corners;
- zero vertices added by non-manifold fan splitting.

Every pre-fix GN-VM quad matched Blender after a one-to-one nearest-vertex map.
Blender's 1,512 additional quads were all negative padded-grid boundary caps:
504 on each of X-, Y-, and Z-, with none on the positive sides.

## Resolved cause

The face-emission loop started `x`, `y`, and `z` at one for all three edge
orientations. A quad around an X edge needs negative-side neighbors only in Y
and Z, so X may start at zero; the corresponding rule applies to Y and Z.
The shared lower bound therefore skipped exactly the three negative caps.

The corrected loop visits all grid-edge coordinates and guards only the two
orthogonal negative neighbors for each orientation. A focused test now covers
X-, Y-, and Z-boundary crossings. The D-surface is closed and matches Blender's
vertex count, quad count, edge count, Euler characteristic, and rounded bounds.

The scalar-grid diagnostic callback remains available to export the 64-cubed
Volume Cube grid and 71-cubed transformed grid, including transform metadata,
isolation, counts, and a byte-level hash.

## OpenVDB ambiguous cells

The follow-up TPMS.018 investigation established that Blender/OpenVDB does not
use a scalar asymptotic determinant for ambiguous cells. OpenVDB classifies the
eight corner signs with fixed `sAmbiguousFace` and `sEdgeGroupTable` lookup
tables, and conditionally complements a mask when its neighboring cell exposes
the matching opposite ambiguous face.

The VM now uses those Apache-2.0 OpenVDB tables directly. At TPMS.018's first
`Volume to Mesh` boundary, Blender and GN-VM both produce 22,932 vertices and
22,938 quads. The 188 ambiguous faces resolve to 22,356 one-component cells and
288 two-component cells, with zero missing or duplicate quad corners. The
remaining full-result difference begins at the downstream hard-sphere Boolean.

## Thirteen-root regression snapshot

The diagnostic-only change leaves all roots unchanged:

| Root object | Before | After |
| --- | ---: | ---: |
| Math Clay Study.003 | 23,968 / 23,966 | 23,968 / 23,966 |
| Math Clay Study.002 | 30,644 / 30,642 | 30,644 / 30,642 |
| Math Clay Study.008 | 17,061 / 28,525 | 17,137 / 28,606 |
| Math Clay Study.006 | 29,226 / 29,226 | 29,226 / 29,226 |
| Math Clay Study.007 | 108,958 / 108,924 | 108,958 / 108,924 |
| Math Clay Study.014 | 129,503 / 125,916 | 129,503 / 127,614 |
| Math Clay Study.018 | 42,770 / 42,768 | 42,770 / 42,768 |
| Math Clay Study.019 | 133,373 / 128,394 | 133,373 / 131,484 |
| Math Clay Study.013 | 85,696 / 86,010 | 85,663 / 86,457 |
| Math Clay Study.001 | 14,887 / 25,665 | 14,868 / 25,617 |
| Math Clay Study.004 | 35,200 / 35,198 | 35,200 / 35,198 |
| Math Clay Study.005 | 61,098 / 61,124 | 61,098 / 61,124 |
| Dsurface | 35,054 / 33,540 | 35,054 / 35,052 |

Counts are vertices / polygon faces from `runGenerator`; the seven previously
exact roots remain exact and Dsurface becomes the eighth exact root.
