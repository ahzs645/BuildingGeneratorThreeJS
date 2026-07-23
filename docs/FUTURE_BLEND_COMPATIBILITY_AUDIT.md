# Future Blender file compatibility audit

## Scope

This audit covers the path used to turn a Blender file into a browser-evaluable
Geometry Nodes program:

```text
.blend
  -> tools/vite-blend-import.ts
  -> tools/dump_blend.py
  -> portable dump JSON
  -> src/gnvm/index.ts
  -> src/gnvm/evaluator.ts + node handlers
  -> TriSoup + material dispatch
```

The current implementation is a strong parity runtime for the supplied Node
Dojo corpus. It is not yet a general compatibility boundary for arbitrary
future Blender files. The distinction matters: exact results on known fixtures
prove implemented semantics, while a compatibility boundary must also reject,
isolate, or precisely describe semantics it does not understand.

This document does not propose parsing `.blend` bytes in JavaScript. Blender
remains the authoritative extractor. The browser contract begins at the
portable dump.

## Evidence from the current repository

Measured against the 101 catalog entries at this checkpoint:

- The catalog references 75 unique dump files.
- All 75 dumps report Blender `5.1.2`.
- Five dumps contain `extraction_metadata.schema_version: 1`; 70 are legacy
  dumps without the metadata envelope.
- The runtime registry contains 151 node-type keys. A registry key means a
  handler exists, not that every operation, mode, domain, data type, or socket
  layout of that Blender node is supported.
- After ignoring editor-only/gizmo records, seven catalog roots have a
  statically reachable unsupported type. Several of those assets still
  evaluate their published cases because the unsupported nodes are on inactive
  branches. Static reachability and exercised runtime coverage are therefore
  both necessary.
- There is no JSON Schema or equivalent structural validator at the import
  boundary. `src/blend-import.ts` currently accepts a JSON value when
  `node_groups` is an object.
- Blender version is recorded and displayed but is not consumed by a
  migration, normalization, or compatibility policy.

Existing strengths worth preserving:

- Socket identifiers are retained, and modifier values bind identifier-first.
- Links retain endpoint identifiers, type hints, mute state, and multi-input
  ordering.
- Nested node groups and object dependencies are traversed.
- Typed extraction metadata is additive, so legacy payloads remain readable.
- Dependency cycles are detected and reported.
- Small dependency objects can carry base and evaluated mesh snapshots.
- Materials, shader node groups, images, and font-outline atlases have portable
  representations.
- Node semantics have focused Blender-derived regression fixtures throughout
  `src/gnvm/*.test.ts` and `tools/gnvm-nodetest.ts`.

## Highest-priority compatibility work

### P0. Put a versioned validator and normalizer in front of GN-VM

Introduce a single boundary:

```ts
normalizePortableDump(
  unknownPayload,
  policy,
): {
  dump: CanonicalDumpV1;
  diagnostics: ImportDiagnostic[];
  sourceVersion: SourceVersion;
}
```

The normalizer should:

1. Validate required object, node-tree, node, socket, link, modifier, and
   dependency shapes before evaluation.
2. Accept the legacy payload and metadata schema 1, upgrading both into one
   canonical in-memory model.
3. Refuse a newer metadata schema with an explicit `SCHEMA_TOO_NEW` diagnostic
   instead of evaluating it as schema 1.
4. Check referential integrity: modifier roots, nested groups, node names, link
   endpoints, socket identifiers, collection members, object pointers, and
   embedded dependency claims.
5. Preserve duplicate interface names while requiring an unambiguous
   identifier/occurrence identity.
6. Preserve unknown properties in a source record so a later migrator does not
   destroy data it does not yet understand.
7. Attach a path to every warning/error, for example
   `node_groups/Root/nodes/Mesh Boolean/props/operation`.
8. Apply explicit size limits to nodes, links, embedded images, font atlases,
   evaluated snapshots, and recursive nesting before allocating VM objects.

Do not spread legacy aliases through node handlers. Normalize older/newer
socket layouts and property names once, then let handlers consume the canonical
contract.

### P0. Replace binary node coverage with semantic capability reports

`REGISTRY.has(node.type)` is necessary but insufficient. Capability records
need to describe the handler's supported semantic surface:

```ts
type NodeCapability = {
  nodeType: string;
  support: "exact" | "bounded-approximation" | "passthrough" | "unsupported";
  blenderVersions?: string;
  operations?: string[];
  dataTypes?: string[];
  domains?: string[];
  modes?: string[];
  requiredAdapters?: ("manifold" | "bullet-hull" | "bvh" | "openvdb")[];
};
```

Examples of current ambiguity:

- An unknown `ShaderNodeMath.operation` silently falls back to `ADD`.
- Unsupported Vector Math operations are reported with a synthetic key, but
  most handlers do not report unsupported property combinations.
- `GeometryNodeSetID` is intentionally a geometry passthrough, but appears as a
  normal registered handler.
- Bake is a live-value passthrough; it does not restore Blender bake state.
- Static graph browsing may find unsupported nodes on inactive switch branches,
  while one runtime parameter case reports no fallback.

The import report should include:

- missing nested groups and broken links;
- unsupported node types;
- supported node types with unsupported operations/modes/data types/domains;
- passthrough and bounded-approximation nodes;
- external adapters that must load;
- unresolved dependencies/resources;
- static reachable coverage;
- exercised coverage for every tested parameter case;
- an output-impact trace showing whether an unsupported node can reach the
  selected Group Output.

Unknown-node fallback should be safe and typed. Returning one Geometry value
for every output, including scalar/vector outputs, can hide an invalid graph.
Add a strict evaluation mode that refuses to publish an output affected by an
unsupported semantic. Keep permissive fallback only as an explicitly labelled
diagnostic preview.

### P0. Define the modifier-stack contract

Arbitrary Blender objects cannot be represented correctly by selecting the
first Geometry Nodes modifier and feeding raw `obj.data` into it.

The extractor/runtime contract must identify:

- target object by document-local ID;
- target modifier by document-local ID plus stack index;
- evaluated input geometry immediately before that modifier;
- whether the desired output is immediately after that modifier or after the
  full modifier stack;
- transforms and coordinate space of every snapshot;
- all earlier modifiers that were baked into the input snapshot;
- later modifiers omitted from a GN-only preview.

Current extraction explicitly reproduces Hook modifiers before the selected
Geometry Nodes modifier. Mirror, Array, Armature, Subdivision, Solidify, earlier
Geometry Nodes modifiers, and other pre-GN modifiers are not generalized.

The near-term portable solution is to ask Blender for an authoritative
pre-modifier snapshot at the selected stack position. Longer term, a stack
runner may evaluate consecutive supported GN modifiers while treating
unsupported modifiers as Blender-baked boundaries.

### P0. Add multi-version extraction fixtures

The current 75-dump corpus exercises only Blender 5.1.2. Socket-presence
heuristics already handle several known old/new layouts, but they are not a
version policy.

For each supported Blender line:

1. Extract the same small canonical `.blend` fixture with that Blender binary.
2. Normalize both dumps.
3. Assert the canonical program is equivalent where Blender semantics are
   equivalent.
4. Store intentional semantic differences as named compatibility profiles,
   never asset-name exceptions.
5. Run node-level Blender truth probes for every changed node layout.

The fixture should cover:

- group interface panels and duplicate socket names;
- menu sockets and dynamic Menu/Index Switch items;
- rotation sockets and Euler/rotation conversion nodes;
- Repeat, Simulation, and For Each Geometry Element zones;
- paired zone nodes and dynamic state/generation items;
- muted nodes and muted links;
- multi-input link ordering;
- Principled BSDF socket renames;
- an unknown future node and an unknown future property on a known node.

`extraction_metadata.extractor.blender_version` should select a normalizer
profile. Handlers should not parse display labels to infer a Blender version.

## Dependency and source-data work

### P1. Make dependencies a complete graph, not an object-only prepass

The v1 typed descriptors are the right foundation. Extend them with:

- stable source paths through nested groups;
- optional versus required dependencies;
- library identity and file fingerprint;
- source-versus-snapshot choice;
- coordinate space and units;
- snapshot generation Blender version;
- licensing/distribution status;
- missing/packed/external state;
- dependency content hash.

Evaluation should receive an immutable `EvaluationContext` rather than reading
and mutating process-wide `DUMP_CONTEXT`. This enables:

- concurrent evaluations;
- deterministic cache keys;
- cancellation;
- dependency-specific diagnostics;
- testing two dumps in one process without state leakage.

The same applies to `MISSING`: coverage belongs to one evaluation result, not a
global map.

### P1. Capture the source types future Geometry Nodes can consume

The current mesh/curve snapshot path should be extended deliberately for:

- point clouds;
- instances that should remain instances;
- volumes/OpenVDB grids or an explicit Blender-baked mesh boundary;
- grease-pencil/curves data where supported by the target Blender version;
- mesh attributes beyond scalar, vector, RGB, and UV, including 2D integer,
  quaternion/rotation, byte, and four-component color data;
- corner normals, sharp flags, active/render UV layers, color-space metadata,
  and attribute type/domain provenance;
- shape keys and evaluated deformation when they occur before the selected
  modifier.

Dropping alpha from color attributes is acceptable only for a declared
three-channel consumer. The portable source format should retain all four
components so a future material or Geometry Nodes graph can use alpha.

### P1. Treat frozen evaluated snapshots as a declared fallback

Snapshots are useful for cyclic dependencies, unsupported source modifiers, and
external linked assets. Every snapshot should record:

- source object/data ID;
- source and target spaces;
- Blender/extractor versions;
- dependency/file fingerprint;
- frame and scene settings;
- modifier-stack boundary;
- whether attributes, instances, curves, materials, and normals survived;
- reason the live dependency is unavailable.

A snapshot must not silently override a live procedural dependency merely
because its topology differs.

## Material and resource compatibility

### P0. Validate material graphs separately from geometry coverage

Geometry-node registration does not imply shader support. Produce a material
capability report per used material slot:

- active Material Output and connected Surface/Volume/Displacement paths;
- supported shader nodes and property combinations;
- linked inputs reduced to constants versus evaluated procedurally;
- geometry attributes/UV maps required by the shader;
- image/font/external resources and their availability;
- selected backend (`materialx`, baked PBR, legacy authored, normalized);
- exact, approximate, or missing status for each output path.

The current basic-material fallback correctly discloses linked inputs, but
future import should use one graph IR and backend selection rather than
asset-specific pattern matchers accumulating as the primary architecture.

### P0. Preserve image semantics

For every image dependency, extract:

- packed bytes when legally distributable, or a content-addressed external
  reference;
- width, height, channels, bit depth, alpha mode, and color space;
- source type (file, generated, tiled/UDIM, sequence, movie, render result);
- interpolation, extension, projection, frame, and tile metadata used by each
  Image Texture node;
- scene-linear versus encoded pixel representation;
- HDR values without clamping to 8-bit RGBA.

The current `pixels_rgba8` path clamps Blender float pixels into 8-bit values
and does not carry color-space metadata. In addition, full-file local import
does not pass a target object, so the target-only image embedding condition does
not embed shader textures. These cases need explicit diagnostics rather than a
material that merely looks different.

### P1. Preserve material/render settings outside node trees

Node graphs are not the whole Blender material contract. Capture the relevant
material settings for the source Blender version, including surface render
method, shadow behavior, backface culling, displacement method, volume use, and
viewport color. Capture world/view-transform/environment settings separately
when the comparison claims authored rendering.

## Runtime modularity for future nodes

### P1. Move from registration side effects to explicit runtime assembly

Today importing `src/gnvm/index.ts` imports every node module, which mutates a
global registry. Prefer:

```ts
const runtime = createGeometryNodesRuntime({
  handlers: [
    coreMathHandlers,
    meshHandlers,
    curveHandlers,
    instanceHandlers,
    volumeHandlers,
  ],
  adapters: { manifold, bulletHull, bvh, openVdb },
  policy,
});
```

Each handler module should export:

- handlers;
- semantic capability manifests;
- Blender truth fixture IDs;
- optional heavy-adapter requirements;
- known approximation notes.

This makes future Blender nodes additive, lets static analysis identify required
WASM before evaluation, and stops every graph from initializing Manifold and
Bullet Hull unconditionally.

### P1. Split handlers by Blender concept

`src/gnvm/nodes/extra.ts` is over 4,000 lines and spans unrelated concerns:
switches, procedural textures, topology, primitives, fields, legacy helpers,
and booleans. Split it along the same capability boundaries used by the
manifest. A handler should not need asset or node-group names to select
semantics.

The named group fast paths in `src/gnvm/evaluator.ts` should become explicit
normalization/lowering passes keyed by a graph signature and versioned
compatibility rule. Group names are user-editable and can collide in unrelated
files.

### P2. Add derived indexes and incremental evaluation after correctness

Once the canonical model and immutable evaluation context exist, derive:

- group/node predecessor and successor indexes;
- output-impact reachability;
- dependency hashes;
- per-node timing;
- dirty propagation;
- cancellable per-node/group cooking;
- bounded caches keyed by canonical graph, dependency, frame, and overrides.

These indexes are runtime artifacts, not serialized truth.

## Exact tests to add

### Import/schema tests

1. **Legacy acceptance:** a metadata-free current fixture normalizes to schema 1
   and evaluates with unchanged counts/bounds.
2. **Schema 1 acceptance:** an extracted schema-1 fixture round-trips through
   normalize/serialize without changing node/socket/link/dependency identity.
3. **Newer schema refusal:** `schema_version: 2` returns `SCHEMA_TOO_NEW`; GN-VM
   is not invoked.
4. **Broken group reference:** a Group node naming an absent tree reports its
   exact source path.
5. **Broken link endpoint:** a link naming an absent node or socket is rejected.
6. **Duplicate names:** two interface inputs with the same name and distinct
   identifiers retain two values; a name-only override is rejected as
   ambiguous.
7. **Resource bounds:** an oversized embedded image/font/snapshot is rejected
   before base64 decoding or mesh allocation.
8. **Unknown preservation:** an unknown node property survives a
   normalize/serialize round trip and appears in diagnostics.

### Capability tests

1. A known node with an unknown operation is `unsupported-operation`, not
   silently the default operation.
2. A passthrough node is reported as `passthrough`, not `exact`.
3. A muted unsupported node is reported but does not taint the output.
4. An unsupported node on an inactive switch branch is statically reachable but
   absent from one exercised case; another case that selects it is tainted.
5. An unsupported scalar-output node feeding Set Position taints Geometry
   output in strict mode.
6. A disconnected unsupported node does not taint Group Output.
7. A missing nested group is non-portable even if a permissive preview can
   render another branch.
8. Required adapter reporting lists Manifold/OpenVDB/BVH only when reachable
   semantics need them.

### Blender-version tests

1. Extract the same fixture with two supported Blender versions and compare
   canonical socket/interface/link identity.
2. Curve Line old/new socket layouts normalize to one canonical mode.
3. Resample Curve property-menu and menu-socket layouts normalize identically.
4. Old Euler nodes and newer Rotation nodes produce the same canonical
   rotation operation where Blender semantics match.
5. Principled BSDF old/new socket names map to the same material IR.
6. A new socket/property unknown to the older normalizer is preserved and
   diagnosed, never dropped.
7. Extractor execution under an unsupported Blender version fails with an
   explicit supported-range message or produces an `unverified-version`
   diagnostic according to policy.

### Modifier/dependency tests

1. `Mirror -> Geometry Nodes`: Blender's pre-GN evaluated snapshot is the VM
   input; raw `obj.data` is demonstrably different.
2. `Geometry Nodes A -> Geometry Nodes B`: selecting B receives A's evaluated
   output and identifies both stack positions.
3. `Geometry Nodes -> Solidify`: GN-only and full-stack outputs are distinct,
   labelled contracts.
4. Two NODES modifiers on one object can be selected by modifier ID even when
   names are duplicated.
5. Object Info nested dependency order is deterministic.
6. A dependency cycle reports the cycle and uses a declared snapshot, never an
   accidental partially evaluated object.
7. Linked-library dependency fingerprints change the evaluation cache key.
8. Two evaluations in parallel do not share active object, frame, images,
   evaluated objects, or missing-node diagnostics.

### Source-geometry tests

1. Four-component color attribute alpha survives extraction and reaches a
   Store/Named Attribute consumer.
2. Multiple UV maps retain active/render roles and CORNER ordering.
3. A point-cloud dependency stays a point cloud through Object Info.
4. A curve dependency retains controls, handles, cyclic state, tilt, radius,
   tangent/normal provenance, and coordinate space.
5. A volume dependency is either evaluated by a declared adapter or rejected
   with `UNSUPPORTED_SOURCE_COMPONENT`.
6. An evaluated snapshot records frame, stack boundary, space, Blender version,
   and content hash.

### Material/resource tests

1. A packed sRGB PNG and a Non-Color data texture retain distinct color-space
   semantics.
2. An HDR image preserves values above 1.0.
3. A missing external image is reported by material and source node path.
4. UDIM tiles and image sequences report unsupported/available state
   explicitly.
5. A Principled constant material selects the normalized/basic backend without
   claiming procedural parity.
6. A linked procedural input reports exact/approximate/missing status for every
   consumed path.
7. A geometry attribute used only by a shader is retained by TriSoup.
8. Surface, Volume, and Displacement paths are audited independently.

### Regression gates

1. Normalize and capability-audit all 75 unique current dumps.
2. Evaluate all 101 catalog roots at their published defaults in strict mode;
   any accepted approximation must be allowlisted by semantic capability and
   evidence, not asset ID.
3. Exercise every catalog control edge/default case so inactive-branch gaps are
   visible.
4. Preserve existing topology/bounds/material allocation evidence.
5. Run extractor fixtures in Blender plus `npm test`, GN-VM node tests,
   dependency validation, build, and catalog evidence audit.

## Recommended implementation order

1. Finish and adopt static program capability analysis.
2. Add canonical dump validation/normalization and import diagnostics.
3. Make runtime fallback typed and add strict output-taint tracking.
4. Define modifier identity and pre-/post-modifier snapshot contracts.
5. Replace global dump/coverage state with immutable per-run context.
6. Add a second Blender-version fixture suite.
7. Complete typed dependency/resource descriptors.
8. Introduce material graph capability reports and lossless image metadata.
9. Convert handlers to explicit modules/manifests and split `extra.ts`.
10. Add incremental cooking only after the preceding correctness boundaries are
    stable.

This sequence makes new files fail descriptively before it tries to make more
files appear to work. It also turns each new Blender node implementation into a
small, independently testable addition instead of another exception in a
global evaluator.
