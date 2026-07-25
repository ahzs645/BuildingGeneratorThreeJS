# Watertight Bolt frozen-grid cross-check

This fixture separates the Watertight Bolt repeat's source mesh, signed-distance
sampling, resampling, and contouring stages. It does not change GN-VM node
semantics.

The central result is that both one-pass sources have 21,642 vertices and
21,818 faces, and their bounds differ by less than `9.54e-7`, but they produce
80 different signs on the shared `43 x 43 x 71` lattice. Once either source is
frozen, Blender and GN-VM produce all 131,279 scalar values byte-for-byte
identically. Both meshers then agree on topology counts, and Blender/OpenVDB
repeats one topology hash in 10/10 runs.

| Frozen source | Raw-grid hash (FNV-1a 64) | GN-VM mesh | Blender/OpenVDB |
| --- | --- | --- | --- |
| GN-VM pass one | `c4c1dc6efca3377b` | 15,400 verts / 15,302 quads | 15,400 / 15,302, 10/10 |
| Blender pass one | `81d4956a0cc90c60` | 15,318 verts / 15,220 quads | 15,318 / 15,220, 10/10 |

See `evidence.json` for complete hashes, bounds, source-swap statistics, and the
historical `131278/131279` distinction.

## Files

- `gnvm-current/pass1-mesh.json.gz`: evaluated GN-VM mesh with the authored
  `hole patch` repeat forced to one iteration.
- `gnvm-current/pass2-raw.f32.gz`: the second `Volume Cube` grid generated from
  that frozen source.
- `blender-current/pass1-mesh.json.gz`: one live Blender 5.1.2 repeat-one
  schedule result.
- `blender-current/pass2-raw.f32.gz`: Blender's signed-distance samples from
  that native source on the same lattice.
- Each `pass2-raw.json` records lattice metadata and the uncompressed binary
  hash.

The compressed files are inputs, not golden output renders. Mesh JSON contains
`positions` and polygon `faces`; float grids are little-endian float32 with X
as the fastest-changing coordinate.

## Reproduce the GN-VM fixture

From the repository root:

```sh
npx tsx tools/watertight_cross_grid_capture.ts \
  public/dojo/n03d/bolt-watertight/dump.json \
  "Bolt Gen_DHTS_Thru Head v03.003" \
  /tmp/watertight-gnvm
```

The dump SHA-256 must be
`21f31c0fcb495606d930e46c9e03eb27ce7133d8a342a4121f39387562f6054b`.

## Export and sample a Blender source

Set `BLENDER` to Blender 5.1.2 and `N03D_BLEND` to the supplied 3D-printing
utilities file. The tested blend SHA-256 is
`6a0ede9dc9f8f097740716bffba6781acaca71caabd1591614f4a74863d304ca`.

```sh
"$BLENDER" "$N03D_BLEND" --background \
  --python tools/watertight_cross_grid_blender.py -- \
  export "Bolt Gen_DHTS_Thru Head v03.003" /tmp/blender-pass1.json.gz

"$BLENDER" --background \
  --python tools/watertight_cross_grid_blender.py -- \
  sample /tmp/blender-pass1.json.gz \
  tools/fixtures/watertight-cross-grid/gnvm-current/pass2-raw.json \
  /tmp/blender-source.f32 /tmp/blender-source.json

npx tsx tools/watertight_cross_grid_sample_gnvm.ts \
  /tmp/blender-pass1.json.gz \
  tools/fixtures/watertight-cross-grid/gnvm-current/pass2-raw.json \
  /tmp/gnvm-source.f32 /tmp/gnvm-source.json

cmp /tmp/blender-source.f32 /tmp/gnvm-source.f32
```

## Cross-mesh either grid

```sh
npx tsx tools/watertight_cross_grid_gnvm.ts raw \
  tools/fixtures/watertight-cross-grid/gnvm-current/pass2-raw.f32.gz \
  tools/fixtures/watertight-cross-grid/gnvm-current/pass2-raw.json \
  /tmp/gnvm-mesh.json

"$BLENDER" --background \
  --python tools/watertight_cross_grid_blender.py -- \
  mesh tools/fixtures/watertight-cross-grid/gnvm-current/pass2-raw.f32.gz \
  tools/fixtures/watertight-cross-grid/gnvm-current/pass2-raw.json \
  10 /tmp/blender-mesh.json
```

The Blender harness converts the X-fast binary into an `[x, y, z]`
C-contiguous NumPy array before `copyFromArray`. A strided transpose is not
accepted correctly by Blender's OpenVDB binding. It also maps exact zero padding
to a positive SDF exterior so the inactive background is not equal to the
isosurface.
