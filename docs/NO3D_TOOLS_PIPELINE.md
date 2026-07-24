# No3d Tools Geometry Nodes pipeline

The local library at `/Users/ahmadjalil/Documents/No3d Tools` currently contains
47 Blender files. They are source assets, not application dependencies: BlendBridge
reads a user-selected file, creates a transient local copy for Blender extraction,
returns a portable JSON dump, and removes the copy. Source `.blend` files are never
modified.

## Implemented path

1. The local Vite endpoint accepts plain, Gzip-compressed, or
   Zstandard-compressed `.blend` envelopes and runs `tools/dump_blend.py` in
   background Blender.
2. BlendBridge discovers every Geometry Nodes modifier plus every top-level,
   reusable Geometry Node group that is not only a nested dependency.
3. The imported dump is mounted as the controlled source of the graph editor.
   Graph edits remain in the studio draft and can be exported as portable JSON;
   they are not claimed to round-trip back into Blender.
4. Modifier targets run through `runGenerator`. Asset-only groups run directly
   through `runNodeGroup`, with identifier-first input binding, selectable geometry
   inputs/outputs, and cube, plane, curve, or extracted-object seed geometry.
5. Changes are debounced for 250 ms and evaluated in a replaceable worker. A failed
   evaluation reports diagnostics while the renderer retains its last valid result.
6. Static capability coverage and executed-path fallbacks are shown separately.
   A registered handler is not presented as proof of Blender parity.

## Real-file checks

| Asset | Entry path | Result |
| --- | --- | --- |
| `simple-bin-generator.blend` | modifier object | Zstandard upload accepted; Blender 5.1.2 extracted 16 groups and one Geometry Nodes modifier |
| bundled Dojo bin sample | modifier object | 57,008 vertices, 55,024 faces, 110,572 triangles; 685 executed nodes with no runtime fallback |
| `dojo-mesh-repair.blend` | asset-only group | cube seed produced 8 vertices, 6 faces, and 12 triangles with no missing executed node types |
| `dojo-crv-wrapper-v4.blend` | asset-only group | curve-circle seed produced a 16-point curve with no missing executed node types |
| `dojo-bolt-gen-v05.blend` | modifier object | default path produced 15,625 vertices, 22,975 faces, and 31,242 triangles with no runtime fallback |

These checks prove that both modifier and asset-group entry paths work. They do not
prove visual or numeric parity with Blender; that requires checked-in Blender-truth
fixtures for selected inputs and outputs.

## Node semantics added during the audit

- `FunctionNodeInvertRotation`
- `GeometryNodeFieldMinAndMax`
- `GeometryNodeRemoveAttribute`
- `GeometryNodeSetPointRadius`
- `GeometryNodeWarning` show/pass-through behavior
- `GeometryNodeSelfObject`
- editor-only `GeometryNodeGizmoLinear` and `GeometryNodeGizmoDial`

Gizmo nodes are intentionally classified as editor-only and return empty transform
geometry. They do not pretend to reproduce Blender viewport interaction.

## Remaining compatibility work

The sampled files expose two different kinds of remaining work:

- The Simple Bin static closure still contains
  `GeometryNodeOffsetCornerInFace` ×4,
  `GeometryNodeCornersOfVertex` ×2,
  `GeometryNodeEdgesOfCorner` ×1, and
  `GeometryNodeMeshFaceSetBoundaries` ×1.
- Non-default Bolt branches still expose `GeometryNodeUVUnwrap` ×4,
  `FunctionNodeInvertMatrix` ×1, and
  `FunctionNodeSeparateTransform` ×1.

Prioritize these by an executed branch and a Blender-truth fixture, not by static
count alone. A handler that is never reached by the selected controls is less urgent
than a lower-count node that blocks a common tool.

The direct group runner deliberately has a narrow boundary. It resolves primitive
or extracted seed geometry and normal group dependencies, but it does not yet
pre-cook nested Geometry Nodes object dependencies as comprehensively as
`runGenerator`. The dump context and runtime missing-node collector are also global,
so evaluations should remain serialized within each worker.

## Recommended next slices

1. Build a small parity corpus from the five assets above: fixed inputs, Blender
   mesh/curve summaries, material slots, attributes, bounds, and deterministic hashes.
2. Add per-node timing and structured diagnostics so the studio can point to the
   exact group, node, socket, and branch that failed.
3. Implement and fixture the four remaining mesh-topology nodes used by Simple Bin,
   then the three optional Bolt-branch nodes.
4. Add dependency cooking to `runNodeGroup` for asset groups that reference other
   evaluated objects.
5. Turn reviewed No3d tools into a searchable preset library only after provenance,
   license, entry target, seed contract, and parity status are recorded per asset.
