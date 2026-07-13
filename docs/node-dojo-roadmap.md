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

## Recommended next targets

1. **Chrome Asset Library** — 43 active objects, 26 modifier roots, 404 groups. Five root families are complete; continue in increasing reachable-node complexity.
2. **N03D 3D-printing Utilities** — 73 active objects, 39 roots, 639 groups. Start with one isolated bolt, dowel, or clevis-pin generator rather than loading the whole library.
3. **New Joint Generators** — 32 active objects, 13 roots, 572 groups. Pipe and dowel generators are the clearest individual products; Bubble Putty is a larger field/volume target.
4. **More Math Clay surfaces** — 33 active objects and 14 root families. Low-risk as baked gallery pieces; substantially more work for a live TPMS evaluator.
5. **The Nodes Node** — 17 active objects, 12 roots, 5,498 total nodes. Treat as a collection, not one graph.

## Needs source or scope clarification

- **Knit Graphic** — 262 Geometry Node groups exist, but no object currently has an active Geometry Nodes modifier.
- **Dusty Crystal Cocoon** — the only active node modifiers reported by Blender are `Auto Smooth`; the authored result appears baked or driven outside the active modifier path.
- **Modules 2–4 and Intro Module** — teaching scenes containing 4,000–13,000 nodes and dozens of unrelated modifier roots. Select a named exercise/object before porting.
- **Typewriter font** — Blender references `NFT_ Caveman/NFT PIXEL FONT LIBRARY/Blurmed.ttf`, which is absent from the supplied folder.
