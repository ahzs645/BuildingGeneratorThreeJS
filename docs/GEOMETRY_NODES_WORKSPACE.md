# Geometry Nodes workspace vertical slice

## Scope and semantic contract

The browser route is `/crayon`. It presents the extracted Chrome Crayon graph beside the existing Blender-baseline/GN-VM Three.js comparison. The root has 69 nodes and 68 links; its complete dependency closure has 22 groups and 559 nodes. Blender remains semantic truth and GN-VM remains the evaluator. The editor is a projection of `public/dojo/crayon/dump.json`; it does not translate the graph into a second execution model.

The slice supports:

- Blender-oriented category headers, stored custom colors, authored coordinates and widths, output-first full-width socket rows, Blender-like UI typography, socket colors/display shapes, frames, reroutes, and Bezier noodle links;
- a readable Blender-style initial camera framed around the Group Output dependency chain, plus pan, zoom, box/multi-selection, minimap, explicit Frame All, and a full-screen workspace;
- F3/Cmd/Ctrl-F search across the complete group closure and selected-node metadata;
- nested group entry by double-click and a path-preserving breadcrumb bar;
- existing unlinked-socket editing, link creation/removal, undo/redo, JSON open/save, and debounced GN-VM reevaluation;
- exposed modifier controls evaluated by the existing Web Worker GN-VM;
- selected geometry-output probes evaluated inside GN-VM and rendered in amber in the Three.js viewport.

`src/geometry-nodes/graph-model.ts` is the deterministic adapter. Editor node IDs are namespaced by group and source node name. Socket handles retain the exact extracted identifier plus a deterministic duplicate occurrence. Links retain endpoint identifiers, source order, socket type, muted state, and multi-input ordering. Conversion never mutates or repairs the dump.

## Current extraction schema

The current `tools/dump_blend.py` pipeline already records the editor-critical subset:

- node names, Blender types, labels, parent frame names, relative/absolute locations, width/height/dimensions, hide/mute, and custom colors;
- input/output names, identifiers, socket types, display shapes, visibility/value state, and input indices;
- exact link endpoint names/identifiers/types, muted state, and `multi_input_sort_id`;
- group interfaces (including panels), group references, and paired zone metadata.

That payload is also GN-VM's runtime input and has extensive parity fixtures. This slice therefore adds a one-way editor adapter rather than changing extraction or writing XYFlow state back into the payload. Headless Blender commonly exports `ui.dimensions: [0, 0]` and placeholder heights, so the editor preserves authoritative width/location/frame data and derives content height from visible rows where necessary.

## Reference and license review

Reviewed against authoritative repository state on 2026-07-14. No implementation, styling, source, or assets were copied.

- [roman01la/threegn](https://github.com/roman01la/threegn/tree/e1123a2858510e55f7d37bb01b631c6f6219eba3) demonstrates the useful separation of Blender export, graph presentation, and recursive evaluation, plus identifier-oriented socket data and Blender coordinate conversion. Its README calls the project unmaintained/incomplete. It is [EPL-2.0](https://github.com/roman01la/threegn/blob/e1123a2858510e55f7d37bb01b631c6f6219eba3/LICENSE), so this repository uses only independently implemented concepts.
- [Algebraic-UG/tree_clipper v0.1.8](https://github.com/Algebraic-UG/tree_clipper/tree/v0.1.8) informed the migration notes below: versioned envelopes, canonical numeric IDs, explicit external references, ordered links, hierarchy/interface records, reroute identity, and phased node/link import. The package declares [GPL-3.0-or-later](https://github.com/Algebraic-UG/tree_clipper/blob/v0.1.8/packages/tree_clipper/pyproject.toml); no code or fixtures were copied or ported. Relevant compatibility observations are documented by its [specific handlers](https://github.com/Algebraic-UG/tree_clipper/blob/v0.1.8/packages/tree_clipper/src/tree_clipper/specific_handlers.py), [export traversal](https://github.com/Algebraic-UG/tree_clipper/blob/v0.1.8/packages/tree_clipper/src/tree_clipper/export_nodes.py), and [multi-input test](https://github.com/Algebraic-UG/tree_clipper/blob/v0.1.8/packages/tree_clipper/tests/test_multi_input_order.py).
- [whoisryosuke/geometry-node-graph](https://github.com/whoisryosuke/geometry-node-graph/tree/8155eceaff215df50d3ae2a65db99b7338f57c8f) validates React Flow as a practical canvas for Blender-like custom nodes. It has no tracked license or package license declaration, so default copyright applies. Only high-level UI observations were used; its random/time-based IDs and type-only socket handles were avoided.
- [polygonjs/polygonjs](https://github.com/polygonjs/polygonjs/tree/23def6118446acd4209361b272e0041b1060c6a6) informed architecture/UX ideas such as separating dependency state from editor state, dirty propagation, cached cooking, contextual networks, and direct Three.js viewport integration. It does not define Geometry Nodes semantics here. Its repository [LICENSE is MIT](https://github.com/polygonjs/polygonjs/blob/23def6118446acd4209361b272e0041b1060c6a6/LICENSE), while the same commit's [package metadata says PolyForm Shield](https://github.com/polygonjs/polygonjs/blob/23def6118446acd4209361b272e0041b1060c6a6/package.json); because that is inconsistent, this work treats it as conceptual reference only.

## Migration path toward richer dependency metadata

The current dump remains version 1 input until Blender round-trip fixtures justify a new contract.

1. Add an optional sidecar/envelope without changing node payloads: `schema_version`, extractor/Blender versions, source fingerprint, root object/group IDs, warnings, and provenance.
2. Assign exact document-local object, node, interface item, and socket IDs during extraction. Keep current names/identifiers for compatibility and diagnostics. These IDs preserve identity inside one export; cross-export persistence requires a separate opt-in policy, such as UUID custom properties stored in the `.blend`.
3. Add typed external dependency descriptors for objects, collections, materials, images, fonts, scenes, and nested trees. Record source tree/node/socket, target datablock/tree, nested path, provenance, library path, direction, and whether the dependency is embedded, referenced, unavailable, required, or optional.
4. Represent hierarchy and ordering explicitly: parent frame IDs, interface panel parent/order, ordered multi-input links, paired zones, and stable reroute input/output IDs.
5. Build dependency indexes (predecessors/successors), cycle diagnostics, dirty propagation, and cached GN-VM cooking as derived metadata. These optimize evaluation but never override Blender behavior.
6. Introduce a versioned inverse adapter only after round-trip fixtures prove lossless node/socket/link/interface reconstruction in Blender. Import should be phased: allocate trees/nodes and register IDs; resolve parents/dynamic properties and externals; create links; then restore multi-input order.
7. Keep old dump fixtures readable and test migrations in both directions. A richer schema must not silently reinterpret current values or change modifier identifier-first binding. Any Tree Clipper converter remains a separately reviewed interoperability boundary; GPL handlers are not copied into this app.

Until step 6 is proven, editor-only XYFlow position changes and JSON exports are explicitly not claimed as Blender-round-trippable.

## Remaining work

- Make the editor asset-driven, then mount the same workspace for Type Pixel Brush. Resolve its root by the selected object rather than taking the first node modifier in the dump.
- Add a cancellable evaluation manager with explicit queued/running/error state. Selection should be immediate; expensive intermediate preview should be an explicit target, and obsolete workers should be terminated.
- Add structured per-node diagnostics and timing before attempting dependency-aware caching or incremental cooking.
- Frame-relative dragging/resizing and moving a frame with all children need compound editor operations.
- Node creation, dynamic socket declarations, interface panels, socket ranges, and Blender subtypes need more extractor metadata before they can round-trip safely.
- External object/material/image resolution needs the typed dependency records above.
- Camera and selection history are stack-based but not persisted per group across reloads.

## Verification

```sh
npm test
npx tsx tools/gnvm-nodetest.ts
npm run build
```

Browser route: `http://127.0.0.1:5173/crayon` (or the port printed by Vite).
