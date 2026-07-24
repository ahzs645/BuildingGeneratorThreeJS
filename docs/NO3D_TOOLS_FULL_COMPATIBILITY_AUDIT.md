# No3d Tools full compatibility audit

Audit date: 2026-07-24

Source: `/Users/ahmadjalil/Documents/No3d Tools`

Current extractor/runtime: Blender 5.1.2, `tools/dump_blend.py` 1.5, GN-VM

Runtime probe: one isolated process per target, 30-second limit

## Current result

All 47 top-level `.blend` files opened in Blender and produced normalized
dumps. Those dumps expose 108 modifier or reusable-group Studio targets.

| Gate | Result |
| --- | ---: |
| Blender files extracted | 47 / 47 |
| Studio targets discovered | 108 |
| Exact node closures | 93 |
| Portable targets, including bounded approximations | 107 |
| Targets with an unsupported reachable node | 1 |
| Portable targets producing renderable mesh, curve, or point output | 94 |
| Portable targets completing with empty output | 9 |
| Portable targets exceeding the 30-second probe budget | 4 |
| Portable targets throwing an evaluation error | 0 |

This is a large improvement over the first audit (58 exact and 60 portable
targets). It does **not** mean that all 107 portable targets have Blender
parity. Static portability means every reachable node has an executable
contract. Bounded approximations, target input contracts, resource budgets,
and Blender-reference comparisons remain separate truth gates.

The machine-readable evidence summary is
[`no3d-runtime-audit-summary.json`](./no3d-runtime-audit-summary.json). It
records the fresh dump-set and runtime-report hashes, bounded-node counts,
timeouts, and source-packaging warnings used by this report.

## What was implemented

The compatibility pass added or completed:

- edge-smooth and Set Mesh Normal sharpness semantics;
- Integer Math, Axes to Rotation, and native rotation input;
- bounded Mesh/Points to SDF Grid and Grid to Mesh, with Blender 5.1.2
  canonical topology fixtures;
- UV Pack Islands and UV Unwrap, with Blender-derived orientation, scaled
  margin, and canonical coordinate fixtures;
- Points to Vertices and Set Curve Normal;
- curve-handle, material-index, and material-selection fields;
- exact audited 2D and 3D Gabor behavior;
- typed empty-closure identity plus callable Closure-zone execution;
- Menu Switch named item masks used by `separate-half`, including raw string
  and datablock selection values;
- sequential Geometry Nodes modifier-stack execution;
- viewport/render enablement metadata for every Blender modifier;
- bounded, validated embedding and execution of available constant-path STL
  files.

The Studio now derives a target input contract, recommends curve or primitive
seeds, identifies later-modifier stack dependencies, reports unbound datablock
inputs, and defaults large or resource-sensitive closures to explicit preview.
Failed evaluations retain the last valid viewport geometry.

## Static classification

Thirty-five files have exact node closures for every discovered target.
Eleven more are fully portable but contain one or more reported bounded
approximations:

- `apple-magsafe-charger`
- `apple-watch-charger`
- `bic-lighter`
- `bubble-putty-generator`
- `cylinder-from-crv-lathe`
- `dojo-bolt-gen-v05`
- `dojo-bolt-gen-v05-obj`
- `gabor-pattern-airpod-case`
- `putty-flange-generator`
- `spike-putty-1`
- `voronoi-putty-1`

`corner-mounted-skadis` is the only file with a non-portable target. Its
`Corner Mounted Skaddis` closure reaches `GeometryNodeImportSTL`, but the four
authored McMaster-Carr STL paths point to another machine and the files are
absent. The runtime deliberately refuses to fabricate replacement screws.
Its other target is portable.

The 14 portable-but-approximated targets reach one or more of:

| Bounded node | Target closures |
| --- | ---: |
| `GeometryNodeGridToMesh` | 6 |
| `GeometryNodeMeshToSDFGrid` | 5 |
| `GeometryNodeUVPackIslands` | 3 |
| `GeometryNodeUVUnwrap` | 3 |
| `GeometryNodePointsToSDFGrid` | 3 |
| `GeometryNodeVolumeCube` | 4 |
| `GeometryNodeVolumeToMesh` | 4 |

## Runtime findings

The isolated sweep executed every portable target with inferred seeds and
modifier indices. Ninety-four produced renderable output and none threw. Four targets
exceeded 30 seconds:

- `apple-magsafe-charger` · Apple Magsafe Charger
- `apple-watch-charger` · Apple Watch Charger
- `putty-flange-generator` · Putty Flange Generator
- `spike-putty-1` · Spike Putty 1

The two charger closures contain 1,176 and 701 reachable nodes respectively.
Studio auto-evaluation is disabled for closures over 500 nodes, as well as for
volume-grid approximations. These targets remain available through the
explicit Apply action and the 180-second worker safety limit.

The Gabor modifier completed this concurrent audit in 27.4 seconds with
126,628 vertices, 118,195 faces, and 234,619 triangles. Its volume-grid
closure remains manual-preview only.

The large `Dojo Gluefinity Grid_obj.001` closure now completes in 20.6 seconds
with 480 vertices and 252 faces. It remains over the 500-node live-edit
threshold even though the isolated audit completes.

CPU sampling also showed why the safeguards must remain:

- Gabor's former brute-force edge proximity is gone; dense field evaluation
  and face proximity now dominate.
- Apple Magsafe is dominated by repeated float32 closest-triangle projection
  and still exceeds a 60-second isolated budget.
- Putty Flange still exceeds a 60-second isolated budget after its two small
  helper targets complete normally.
- Apple Watch and the large Gluefinity object retain their over-500-node
  manual-preview contracts pending target-specific reduction.

No performance optimization changed a node's numeric contract or topology.

Empty output is not one category:

- `dojo-fillet-by-length`, `view-crv-points`, and `separate-half` need a curve
  or primitive seed. The inferred contract supplies it in Studio.
  `view-crv-points` now exports and renders its two loose point-cloud points
  without inflating mesh topology.
- Arduino Nano and Benchy previously lost their 99,022- and 112,569-vertex
  bases to the generic 10k extraction rule. Extractor 1.5 embeds direct
  modifier bases up to 250k vertices within a 1M-vertex total budget. Real
  refreshed probes reproduce 99,022/74,781 and 112,569/225,154
  vertices/faces with no runtime gaps.
- Four `snap to assembly` helper targets have authored null Object inputs and
  are also empty in Blender. They must remain empty unless the user supplies
  an object.
- Several reusable helper groups have valid empty defaults because their
  boolean/selection or object contracts intentionally select nothing.
- The top-level `Spike Putty 1` and `Voronoi Putty 1` targets still complete
  empty with refreshed embedded bases. Their closures are portable, but they
  need intermediate-output parity probes before they can be called usable.

The visible `nylon-bolt` modifier now matches Blender exactly at **8,735
vertices / 10,070 faces / 17,390 triangles** with identical local bounds.
Blender Face-domain Index uses Geometry Nodes' `-Z, -Y, +Z, +Y, -X, +X`
minimal-cube order, and FLOAT intersection leaves the thread's one cut contour
open before the authored `ETK_Fill Holes` helper closes it. The following
`cl_thumbs` Geometry Nodes modifier is authored with `show_viewport=false`.
Extractor 1.5 preserves that state, so default browser evaluation no longer
adds its hidden thumbnail-line geometry. It remains addressable as an explicit
diagnostic target.

## Source packaging audit

Node implementation cannot repair missing source data:

- Eight files reference unavailable unpacked fonts: `bic-lighter`,
  `bubble-putty-generator`, `corner-mounted-skadis`, `dojo-calipers`,
  `no3d-pixel-markers`, `print-bed-preview-obj`, `spike-putty-1`, and
  `voronoi-putty-1`.
- The fresh extraction found 19 unavailable external image datablocks across
  12 files. Extractor warnings expose them in Studio instead of silently
  implying a portable texture.
- `corner-mounted-skadis` references four unavailable absolute Dropbox STL
  paths, plus a missing font and two missing images.
- The two putty files previously took several minutes to extract because
  Blender attempted to rasterize every glyph from missing fonts. Extractor 1.5
  now skips an unavailable atlas, retains an explicit empty/unavailable font
  contract, and emits one packaging warning instead.

Available STL files are now portable only when all of these conditions hold:

1. The Path input is an unlinked authored constant.
2. The file is at most 32 MiB and 200,000 triangles.
3. It passes strict ASCII or exact-size binary STL validation.
4. Its embedded SHA-256-tagged triangle soup passes runtime validation.

Dynamic paths and absent, malformed, oversized, or changing files remain
unsupported. STL facet normals and attribute bytes are validated but not
retained; STL also carries no authoritative unit or material metadata.

## Remaining work, in priority order

1. Continue reducing face-proximity and deep-field costs in the four
   budget-sensitive targets before enabling live edit; the manual-preview
   policy remains intentional.
2. Reconcile the Print Test Mesh's omitted post-GN Bevel stack and the legacy
   Chrome Crayon's one-loose-vertex alternate-width residual.
3. Pack or license-replace the eight missing fonts, restore required images,
   and supply the four McMaster STLs if those exact screws are intended to ship.
4. Expand beyond the new seam, non-manifold, adaptivity, and budget fixtures
   into curved cyclic UV charts and complex sparse OpenVDB surfaces before
   promoting the bounded implementations to general exact parity.

## July 24 parity fixture follow-up

`tools/gabor_3d_blender_probe.py` and `tools/uv_sdf_blender_probe.py` generate
Blender 5.1.2 truth without relying on screenshots or inferred values.

The checked-in runtime tests now establish:

- exact 3D Gabor Value/Phase/Intensity samples across anisotropy, frequency
  clamping, negative scale, and normalized 3D orientation;
- UV Unwrap parity for two disconnected orthogonal unit islands to `2e-7`;
- UV Pack Islands parity for a rotated single island with margins `0`, `.001`,
  and `.1` represented by the reusable probe;
- Mesh to SDF Grid -> Grid to Mesh parity for the canonical unit cube at
  `.25` voxel size: Blender and GN-VM both produce 152 vertices and 150 faces
  with the same rounded coordinate levels.
- exact canonical polygon-soup topology for an open quad (72/70
  vertices/faces), a three-face non-manifold edge (96/94), and a closed cube
  with one flipped face (152/150);
- seam-aware chart connectivity and continuous rigid unfolding of a
  developable bent strip;
- a four-level adaptivity oracle. Adaptivity is now applied monotonically and
  reaches Blender's 8/6 fully coarse cube endpoint, while the `.1` and `.5`
  dense-clustering results remain explicitly different from OpenVDB;
- a 10-unit cube at `.1` spacing oracle (1,225,043 requested samples and
  61,208 Blender vertices), plus typed budget diagnostics and an explicit
  manual-preview budget override.

Those fixtures close the previously unaudited topology and resource-policy
cases. The UV and volume node families remain marked bounded because Blender's
full LSCM/ABF distortion solver, island packer, and sparse OpenVDB adaptivity
metric are broader than the proven cases. Budget-driven divergence is now
observable and configurable rather than silent.

## Reproducible audit

`tools/audit-no3d-dumps.ts` accepts an extracted dump directory, evaluates each
portable target in an isolated process, applies inferred target contracts, and
writes a machine-readable report. Example:

```bash
node --import tsx tools/audit-no3d-dumps.ts /path/to/dumps \
  --output /tmp/no3d-runtime-audit.json \
  --timeout-ms 30000 \
  --concurrency 3
```

The checked-in code and this report preserve the distinction between handler
coverage, bounded portability, successful execution, and Blender parity.
