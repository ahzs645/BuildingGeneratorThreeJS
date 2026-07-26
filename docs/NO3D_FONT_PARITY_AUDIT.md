# No3d Tools recovered-font parity audit

Audit date: 2026-07-25

This document uses `$NO3D_TOOLS_DIR` for the local No3d Tools library root.

Source library: `$NO3D_TOOLS_DIR`

Repaired derivative library:
`$NO3D_TOOLS_DIR/Font Repaired`

Generated evidence:
`$NO3D_TOOLS_DIR/Font Parity Audit`

Runtime under test: Blender 5.1.2 and the browser GN-VM

The machine-readable roll-up is `audit-summary.json` in the generated evidence
directory. Detailed dump, sweep, capture, and comparison JSON remains beside
the referenced images rather than being reduced to the report table.

## Scope and truth boundary

This audit covers the eight source files whose authored Geometry Nodes graphs
referenced unavailable external fonts:

- `bic-lighter`
- `bubble-putty-generator`
- `corner-mounted-skadis`
- `dojo-calipers`
- `no3d-pixel-markers`
- `print-bed-preview-obj`
- `spike-putty-1`
- `voronoi-putty-1`

The audit distinguishes three separate claims:

1. **Packaging parity**: the repaired `.blend` contains every required font and
   each font is packed into the derivative file.
2. **Geometry parity**: Blender and GN-VM produce the same topology and local
   bounds for a fixed graph and fixed inputs.
3. **Rendered parity**: matched-camera captures have comparable silhouettes.

Rendered-material parity is outside this font audit. Blender Workbench and the
Studio's Three.js renderer use different lighting, tone mapping, material, and
environment contracts, so RGB error is recorded but is not interpreted as a
font-outline failure.

## Non-destructive repaired copies

All eight repaired files were created as new `*-font-repaired.blend` files.
The source files were opened for reading and were never saved over.

| Source | Repaired copy | Replaced font sockets |
| --- | --- | ---: |
| `bic-lighter.blend` | `bic-lighter-font-repaired.blend` | 5 |
| `bubble-putty-generator.blend` | `bubble-putty-generator-font-repaired.blend` | 13 |
| `corner-mounted-skadis.blend` | `corner-mounted-skadis-font-repaired.blend` | 1 |
| `dojo-calipers.blend` | `dojo-calipers-font-repaired.blend` | 3 |
| `no3d-pixel-markers.blend` | `no3d-pixel-markers-font-repaired.blend` | 1 |
| `print-bed-preview-obj.blend` | `print-bed-preview-obj-font-repaired.blend` | 4 |
| `spike-putty-1.blend` | `spike-putty-1-font-repaired.blend` | 8 |
| `voronoi-putty-1.blend` | `voronoi-putty-1-font-repaired.blend` | 8 |

The derivative files contain packed, byte-extractable copies of every required
font. Exact replacement payloads supplied or recovered for the audit are:

| Font | SHA-256 |
| --- | --- |
| Avenir LT 85 Heavy | `2f8249422a0ef3d69dc72626b39cbd023a4c03133f862f762deb9fa51e80ffeb` |
| Avenir LT 95 Black | `1be398097907b569ea35cbc2e78ad7e6404ec7f40910e2ccd17a8cdc5c188943` |
| Archivo SemiBold | `bf9780c4e11442d3604d27fabb62248e0322d1244c7c88ff68d8acc470ae89a5` |
| BlenderPro Thin | `9eb1ae467777c1f9edb1327d8dc6d52f8e3453162895923f5a480122d2ce489d` |
| Druk Text Wide Cyr Bold | `aabab6f3fce8610a43047e1c2a01c66a1b69e18fa423472842e60e1b0e98da12` |
| Druk Text Wide Cyr Super | `967069c34618765b6bb9fcb4f733368e267a2dccfbccc2c4f2edc6c2d4e19c2d` |
| Gridular Regular | `b0c54ff7280c466d02352403b8e62266d3a85f97e0ca6217ec5d01932f867f82` |
| SF Intermosaic | `433c9d903f005c47d738c0c93a301d96b3b5df8ca52e092ec20eb4ba2dcd8003` |

`tools/extract_packed_fonts.py` is the reusable extraction utility. It only
extracts explicitly named packed font datablocks, rejects path traversal,
refuses to overwrite existing files, and emits byte count plus SHA-256
metadata. Raw commercial font payloads remain outside the repository and must
be handled according to their licences.

## Fresh browser artifacts

Every repaired derivative was re-extracted with extractor 1.6. The eight dumps
contain 22 embedded glyph atlases and zero unavailable font payloads.

The fresh isolated browser runtime audit found:

| Gate | Result |
| --- | ---: |
| Repaired files | 8 |
| Studio targets | 46 |
| Exact static closures | 33 |
| Portable closures | 45 |
| Non-portable closures | 1 |
| Targets producing geometry | 39 |
| Valid empty results | 6 |
| Evaluation errors | 0 |
| Timeouts | 0 |
| Not run | 1 |

The one non-portable target is still
`corner-mounted-skadis`'s main `Corner Mounted Skaddis` closure. It references
four absent McMaster-Carr STL files. Fonts are now portable, but this separate
source dependency is deliberately not fabricated.

Six previously exact-labeled targets reach the shared legacy
`Curve Offset(.###)` helper. They remain portable, but the capability report
now exposes its NURBS Set Position behavior as bounded instead of overstating
exact static closure. The final audit used a 90-second per-target allowance;
all targets completed without a timeout.

## Reusable text-helper parameter sweep

The direct Blender-versus-GN-VM harness covers 25 suites, 18 distinct
font-bearing helper groups, and 86 fixed-input cases. It exercises:

- editable Latin text and digits;
- positive and negative numeric readouts and suffixes;
- character, word, and line spacing;
- left, centered, and right alignment;
- text-box wrapping;
- fill and reset-position controls;
- caliper measurement and battery states;
- pixel-marker text transform, extrusion depth, and flat mode;
- Print Bed labels and full helper/root branches;
- downstream realization and boolean consumers.

| Asset | Exact cases | Total |
| --- | ---: | ---: |
| `bic-lighter` | 11 | 11 |
| `bubble-putty-generator` | 19 | 19 |
| `corner-mounted-skadis` | 11 | 11 |
| `dojo-calipers` | 5 | 5 |
| `no3d-pixel-markers` | 5 | 5 |
| `print-bed-preview-obj` | 7 | 7 |
| `spike-putty-1` | 14 | 14 |
| `voronoi-putty-1` | 14 | 14 |
| **Total** | **86** | **86** |

The Print Bed placement residual exposed a non-font runtime bug. Blender's
minimal Mesh Cube stores an explicit edge order, but GN-VM previously derived
edges by walking faces. `build envs` selects edge index 0 and uses its midpoint
for the label, so the different order shifted the label by 100 units. The
runtime now preserves Blender 5.1.2's 12-edge order, with a regression fixture.
All seven Print Bed helper cases are exact after the fix.

## Active-root sweeps

The root-level sweeps currently establish:

- `dojo-calipers`: 3/3 cases have exact topology and bounds, including zero,
  negative 25.4 mm, negative 100 mm, and battery-state changes.
- `no3d-pixel-markers`: 3/3 cases have exact topology and bounds, including the
  default, short-extrusion, and flat modes.
- `print-bed-preview-obj`: 2/2 cases have exact topology and bounds at
  134,407 vertices / 246,771 faces.
- `bic-lighter`, `spike-putty-1`, and `voronoi-putty-1`: the shared lighter
  cutout root has a bounded NURBS field-evaluation residual even though all
  directly tested font helpers are exact. Blender produces 6,129 vertices /
  6,052 faces; GN-VM produces 5,583 / 5,512 in each of the five root cases.

The first lighter divergence is inside nested `Curve Offset.001`, not text or
Mesh Boolean. The branch is exact through Mesh to Curve (48 points), Length
Resample (641 points), Blur (641 points), and Set Spline Type NURBS (7,692
evaluated points). Blender applies Set Position to the 641 NURBS controls and
then re-evaluates; GN-VM currently moves dense evaluated samples and loses the
control representation. The resulting offset curve lengths are 66.8271 in
Blender and 60.5440 in GN-VM. Downstream resampling therefore emits 67 versus
61 profile points. The exact 32-vertex / 20-face snap-tab branch then joins the
divergent lighter body. This is a general NURBS POINT-field boundary and is not
being hidden with a file-specific correction.

## Matched render evidence

The capture path uses the Studio's actual worker and WebGL canvas. Capture mode
retains the drawing buffer, removes the grid, uses a segmentation-key
background, and records the fitted camera state. Blender renders apply the
same Z-up presentation and Three.js camera quaternion. Silhouette comparison
uses equivalent antialiased coverage.

| Asset | Silhouette IoU | Corner RMSE | Topology result |
| --- | ---: | ---: | --- |
| `dojo-calipers` | 0.9888 | 0.34 px | Exact |
| `no3d-pixel-markers` | 0.9863 | 0.95 px | Exact |
| `bubble-putty-generator` helper | 0.9691 | 0.49 px | Exact |
| `corner-mounted-skadis` helper | 0.9653 | 0.53 px | Exact |
| `bic-lighter` | 0.9015 | 4.81 px | Residual |
| `spike-putty-1` | 0.9015 | 4.81 px | Residual |
| `voronoi-putty-1` | 0.9015 | 4.81 px | Residual |
| `print-bed-preview-obj` | 0.8848 | 6.33 px | Exact topology and bounds |

Bubble Putty and Corner Mounted Skadis do not expose a directly capturable
font-bearing active object in their source state. Their table rows therefore
use non-destructive wrapper fixtures for the `VALUE to TEXT` positive decimal
and suffix case. The wrappers add only `Realize Instances`. Their paired
Blender/WebGL topology is exact, and both have 100% bidirectional surface
coverage within one pixel. These representative helper captures remain
separate from claims about the unavailable-STL Corner root.

## Reproduction tools

- `tools/prepare_font_override_blend.py` creates a repaired copy and can pack
  replacement fonts with `NODE_DOJO_PACK_REPLACEMENT_FONTS=1`.
- `tools/extract_packed_fonts.py` safely extracts explicitly selected packed
  fonts for client-side packaging workflows.
- `tools/blender_group_parity_probe.py` evaluates reusable groups in Blender.
- `tools/gnvm-group-parity.ts` evaluates the same cases in GN-VM and compares
  topology plus local bounds.
- `tools/create_group_wrapper_fixture.py` creates a non-destructive visible
  wrapper around a reusable group/case when the source has no capturable active
  object.
- `tools/no3d-font-parity-cases.json` defines the reusable-helper matrix.
- `tools/no3d-font-root-*-cases.json` defines the active-root matrices.
- `tools/capture_blend_studio_dump.mjs` captures the actual browser runtime.
- `tools/render_blender_reference.py` produces the matched Blender reference.

## Final verification

- Repository tests: 430 / 430 passed.
- TypeScript type-check and production Vite build: passed.
- New and modified Blender/Python utilities: compiled successfully.
- Case manifests, audit roll-up, and NURBS diagnosis JSON: validated.
- Eight-file browser audit: zero evaluation errors and zero 90-second
  timeouts.
- Working-tree whitespace validation: passed.

## Remaining boundaries

1. Add broader Blender fixtures for Set Position over NURBS POINT fields, then
   retain and transform control-point metadata through evaluation. Do not
   advertise shared lighter root parity before that general correction.
2. Keep Corner Mounted Skadis non-portable until its four authored STL
   dependencies are supplied.
3. Do not infer material or lighting equivalence from font-outline parity.
