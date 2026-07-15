# Geometry Nodes workspace

## Scope and authority

The first production slice lives at `/crayon` and opens the extracted Chrome
Crayon graph (`public/dojo/crayon/dump.json`) beside its existing Three.js parity
viewport. The authored root contains 69 nodes and 68 links; the complete closure
contains 22 groups and 559 nodes. The slice deliberately keeps two existing
contracts intact:

1. Blender behavior and the extracted Blender RNA data define Geometry Nodes
   semantics.
2. `src/gnvm/index.ts` and its recursive evaluator remain the only browser
   evaluator. The editor sends a cloned dump through the existing
   `crayon-graph-change` event and Web Worker. It does not introduce a competing
   evaluator or rewrite the extractor.

`src/geometry-nodes/adapter.ts` is a pure view-model boundary. It namespaces node
identity by group and the exact extracted node name, retains the exact socket
identifier and source order, resolves the older name/index link fallbacks, and
records nested group dependencies. React Flow state is editor state; the dump is
still the portable document and the GN-VM input.

Headless Blender commonly exports `ui.dimensions: [0, 0]` and a placeholder
`height: 100` even when node contents differ. Width, absolute location, frame
size, socket order, colors, parent name, mute/collapse state, and display shapes
are preserved. Content height is therefore derived deterministically from visible
socket rows instead of claiming unavailable pixel-perfect Blender measurements.

## Implemented slice

- Blender-like node category headers, authored custom colors, source-ordered
  sockets, display shapes, frames, reroutes, muted links, and curved noodles.
- Zoom, pan, fit controls, minimap, marquee/multi-selection, node inspector, and
  node search with focus.
- Group dropdown plus stack-based breadcrumbs. Double-clicking a group node opens
  its nested group; breadcrumb state preserves the navigation path.
- Editable unlinked values, link creation/removal, node moves, undo/redo, JSON
  import/export, and stable selection across dump updates.
- The existing debounced Web Worker bridge reevaluates edits with GN-VM and updates
  the Three.js Chrome Crayon viewport. Selection is intentionally descriptive;
  it does not pretend the evaluator can expose arbitrary intermediate sockets.
- Adapter tests cover deterministic identities, exact link/socket mapping, nested
  dependencies, frames, reroutes, coordinate mapping, and linked flags against the
  real rich graph plus a targeted synthetic graph.

## Reference review and licensing boundary

The implementation is independent. No source or assets from the projects below
were copied or translated.

| Project | Status and license | Conceptual observations used |
| --- | --- | --- |
| [threegn](https://github.com/roman01la/threegn/tree/e1123a2858510e55f7d37bb01b631c6f6219eba3) | The README says it is not actively maintained; last commit inspected was April 2023. [EPL-2.0](https://github.com/roman01la/threegn/blob/e1123a2858510e55f7d37bb01b631c6f6219eba3/LICENSE). | A Blender-data-to-React-graph adapter, custom node/socket rendering, and evaluator/UI separation are useful architectural patterns. Its incomplete evaluator and volatile runtime IDs were not adopted. |
| [Tree Clipper v0.1.8](https://github.com/Algebraic-UG/tree_clipper/releases/tag/v0.1.8) | Active release inspected from July 2026. [GPL-3.0-or-later](https://github.com/Algebraic-UG/tree_clipper/blob/v0.1.8/packages/tree_clipper/pyproject.toml); its code cannot be incorporated into this project without accepting GPL obligations. | Export-local object/socket IDs, ordered multi-input links, explicit reroute sockets, dependency-first nested-tree collection, an external-resource table, and staged import resolution are useful schema observations for a future isolated converter. |
| [geometry-node-graph](https://github.com/whoisryosuke/geometry-node-graph/tree/8155eceaff215df50d3ae2a65db99b7338f57c8f) | Last inspected commit was August 2023; no license file or package license grant was found. | Exported node dimensions and socket presentation informed the review only. Random exporter UUIDs, time-based edges, and socket-type-only handles are specifically avoided. |
| [Polygonjs](https://github.com/polygonjs/polygonjs/tree/23def6118446acd4209361b272e0041b1060c6a6) | The root [LICENSE](https://github.com/polygonjs/polygonjs/blob/23def6118446acd4209361b272e0041b1060c6a6/LICENSE) says MIT, while the same commit's [package metadata](https://github.com/polygonjs/polygonjs/blob/23def6118446acd4209361b272e0041b1060c6a6/package.json) says PolyForm Shield and current editor pricing distinguishes commercial use. Treat as license-ambiguous UX inspiration only. | Hierarchical network navigation, persisted panel history, and separation between scene JSON, UI state, and the runtime dependency graph are valuable product patterns. Polygonjs semantics are not used as Blender semantics. |

Tree Clipper's relevant implementation details are observable in its
[specific handlers](https://github.com/Algebraic-UG/tree_clipper/blob/v0.1.8/packages/tree_clipper/src/tree_clipper/specific_handlers.py),
[export traversal](https://github.com/Algebraic-UG/tree_clipper/blob/v0.1.8/packages/tree_clipper/src/tree_clipper/export_nodes.py),
and [multi-input regression test](https://github.com/Algebraic-UG/tree_clipper/blob/v0.1.8/packages/tree_clipper/tests/test_multi_input_order.py).
Those links document the compatibility target, not code provenance.

## Round-trip migration plan

The current extractor already emits node groups, exact socket identifiers,
parent-frame names, reroutes, `multi_input_sort_id`, modifier inputs, and a flat
`dependency_objects` list. Preserve those fields and add metadata rather than
changing evaluator input:

1. Add an optional, versioned `editor_metadata` envelope. Keep unknown top-level,
   group, node, socket, and link fields opaque through open/edit/save.
2. Give each extracted tree, node, socket, link, and external datablock an
   export-local source ID while retaining today's readable names and identifiers.
   Editor IDs then namespace those source IDs, with the current tuple IDs as the
   compatibility fallback.
3. Replace the flat dependency hint with additive typed records:
   `kind`, source tree/node/socket, target datablock/tree, nested path, provenance,
   library path, and whether resolution is required or optional. Keep the old list
   until all consumers migrate.
4. Import in stages: allocate trees/nodes and register IDs; resolve parents and
   dynamic properties; resolve external mappings; create links; finally restore
   multi-input ordering. Reject incompatible Blender/schema versions explicitly.
5. Build any Tree Clipper converter as a separately reviewed interoperability
   boundary. Do not copy GPL handlers into the browser app or replace the current
   Blender extractor/GN-VM.

## Remaining work

- Intermediate-socket preview/isolation requires an explicit GN-VM debug-output
  contract; selection currently shows metadata and leaves final-output semantics
  untouched.
- Frame-relative dragging/resizing and moving a frame with all of its children
  need dedicated compound edit operations. The current slice preserves absolute
  authored layout and parent metadata and allows individual node moves.
- Node creation, dynamic socket declarations, interface panels, socket ranges and
  Blender subtypes need more extractor metadata before they can round-trip safely.
- External object/material/image mapping needs the typed dependency records above.
- Camera/selection history is stack-based but not yet persisted per group across
  reloads.

## Verification

```sh
npm run test:geometry-nodes
npx tsx tools/gnvm-nodetest.ts
npm run build
```

Browser route: `http://127.0.0.1:5173/crayon` (or the port printed by Vite).
