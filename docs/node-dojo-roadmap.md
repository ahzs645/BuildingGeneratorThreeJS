# Node Dojo browser-port roadmap

Inventory date: 2026-07-12. The source pack contains 16 `.blend` projects.

## Working or represented in the web app

- Recursive Bin Generator — live GN-VM, Blender comparison, baked variants.
- Chrome Crayon — live GN-VM, editable graph, reconstructed shader.
- Simple Bubble Vessel — live GN-VM and Blender comparison.
- Math Clay — baked Schoen Gyroid and Schwarz P-Surface gallery studies.
- Send Nodes Hat — baked gallery assembly.
- Procedural Typewriter — live GN-VM with editable text and scene-frame animation. The referenced `Blurmed.ttf` is missing from the pack, so the web page uses portable vector glyphs.
- Chrome Asset Library: Periodic Brush — live GN-VM with all nine `period pack` collection children, editable distance/scale controls, and exact Blender parity across the validation sweep.
- Chrome Asset Library: Flat Stickie Pack — Blender reference and live GN-VM output match at 28 vertices, 7 faces, and identical local bounds.
- Chrome Asset Library: Polarity Sticker — Arc/Fill Curve output matches Blender at 68 vertices, 4 faces, and identical local bounds.
- Chrome Asset Library: Period Pack Shape — the shared `Geometry Nodes.004` root matches Blender at 28 vertices, 1 face, and identical local bounds; its nine object users are covered by this family.
- Chrome Asset Library: Sticker Noodle Brush — nested Polarity Sticker evaluation and Rotate Instances match Blender across spacing, size, and twist cases (16,252 vertices / 956 faces authored).
- Chrome Asset Library: Sticker Noodle Star — the shared `dot periodic brush.003` family used by eight objects matches Blender across spacing, star radii, and point-count cases (716,079 vertices / 715,520 faces authored).
- Chrome Asset Library: `gn.sticker control` and `gn.sticker control.001` — the 10pt Spoke and Soft Star flat-stickie roots match their Blender quads exactly (4 vertices / 1 face each).
- Chrome Asset Library: Outline Sticker — the `Geometry Nodes.009` root matches Blender across authored scale and outline controls (1,056 vertices / 1,025 faces).
- Chrome Asset Library: Image Pixel Stippler — packed image extraction, image sampling, field memoization, and BVH raycasting match Blender across authored/coarse image cases (72,094 vertices / 71,550 faces authored).
- Chrome Asset Library: UI Window Generator — nested Object Info dependencies, relative transforms, boundary-only Mesh to Curve selection, vector-to-scalar socket conversion, and the recovered Pixels Medium font run in-browser. The page loads the supplied `pixels.ttf`, reports whether it is available, and falls back to the embedded Blender-extracted outline atlas when it is not; authored GN-VM topology is 35,766 / 33,347 versus Blender's 35,886 / 33,474.
- Chrome Asset Library: Chain and Mace — nested baked payloads, instance-domain separation, NURBS/resample tangent frames, curve reversal, rotation fields, and both endpoint/ball switches run live. All five validation cases match Blender face topology exactly; authored bounds differ by at most 0.0187 units and the VM omits only Blender's 1,277 loose curve vertices.
- Chrome Asset Library: Mesh to Curve Helper — `Geometry Nodes.014` exactly preserves the authored quad as one cyclic four-point curve. It intentionally renders no surface (`0 / 0`) in both Blender and the browser because no bevel or profile follows the conversion.
- Chrome Asset Library: Pixel Marker — both users of `pixel marker.001` now run live: `.002` matches Blender at 209 / 134 on the authored flat branch and `.003` at 412 / 428 on the authored 3D branch. Curve-point radius extraction fixed the profile/grid scale; five of six cases per object are topology-exact and the dense pixel-size case remains within two elements and 0.01 bounds units.
- Chrome Asset Library: Soft Pixel Marker — the 167-node `soft pixel marker` root now runs live with Index Switch, Noise Texture, semi-sharp subdivision, split-edge, and Bezier-tangent support. The authored result matches Blender's 5,664 faces and bounds within 0.0001 units (8,450 versus 8,455 vertices); six control cases stay within 1.93% vertex count.
- Chrome Asset Library: `_TEXT.006` — the packed SF Intermosaic outlines now reproduce Blender's raw 160 glyph vertices exactly and improve the final browser result from 1,724 / 1,496 to 1,213 / 975 versus Blender's 1,053 / 960. Remaining work is isolated to downstream N-gon/instance processing.
- Chrome Asset Library: 3D String to Text — the `Dojo_STRING TO TEXT.002` graph now supports Blender-style editable text, word wrapping, alignment, sizing, spacing, planar curve-normal expansion, N-gon filling, and all 119 reachable node handlers in-browser. Authored face topology is exact at 26 faces; GN-VM produces 4,696 vertices versus Blender's 4,446, with local bounds within 0.1667 units.
- Chrome Asset Library: String to Text — `Dojo_STRING TO TEXT` is now editable in-browser with the packed SF Intermosaic outlines, wrapping, alignment, spacing, all three fill-menu outcomes, and reset-letter behavior. The authored face count is exact at 20; GN-VM retains 222 of Blender's 246 vertices and keeps authored bounds within 1.151 units.

## Recommended next targets

1. **Chrome Asset Library** — 43 active objects, 26 modifier roots, 404 groups. Sixteen root families have browser evidence, including both Pixel Marker users, Soft Pixel Marker surface parity, the exact non-surface Mesh to Curve helper, Chain and Mace surface parity, the near-exact UI Window Generator, and both editable String to Text roots; continue in increasing reachable-node complexity. `soft pixel marker.001` is source-blocked by the missing Budokan font.
2. **N03D 3D-printing Utilities** — 73 active objects, 39 roots, 639 groups. Start with one isolated bolt, dowel, or clevis-pin generator rather than loading the whole library.
3. **New Joint Generators** — 32 active objects, 13 roots, 572 groups. Pipe and dowel generators are the clearest individual products; Bubble Putty is a larger field/volume target.
4. **More Math Clay surfaces** — 33 active objects and 14 root families. Low-risk as baked gallery pieces; substantially more work for a live TPMS evaluator.
5. **The Nodes Node** — 17 active objects, 12 roots, 5,498 total nodes. Treat as a collection, not one graph.

## Needs source or scope clarification

- **Knit Graphic** — 262 Geometry Node groups exist, but no object currently has an active Geometry Nodes modifier.
- **Dusty Crystal Cocoon** — the only active node modifiers reported by Blender are `Auto Smooth`; the authored result appears baked or driven outside the active modifier path.
- **Modules 2–4 and Intro Module** — teaching scenes containing 4,000–13,000 nodes and dozens of unrelated modifier roots. Select a named exercise/object before porting.
- **Typewriter font** — Blender references `NFT_ Caveman/NFT PIXEL FONT LIBRARY/Blurmed.ttf`, which is absent from the supplied folder.
