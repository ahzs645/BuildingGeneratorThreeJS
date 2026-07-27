# Interface Performance Review — BlendBridge Studio with the No3d Tools

Date: 2026-07-26 · **Updated 2026-07-27 with post-optimization results (see
"Outcome" at the end).**
Scope: the `/blendbridge` import → edit → evaluate loop, measured with the same
No3d tool set distributed in `No3d Tools.zip` (bolt generator, stackable bin,
bubble putty), using the pre-extracted dumps under `public/dojo/n03d/` and
`public/dojo/dump_bubble.json`.

All timings below were captured on a headless Linux container (Chromium +
Vite dev server, worker evaluation is pure CPU so GPU emulation does not skew
it). Absolute numbers will be faster on a desktop machine; the *ratios* and
the structural findings are what matter.

## Measured behavior

### Import and first preview

| Tool (zip counterpart) | Dump size | Import → targets | First evaluation | Result |
| --- | --- | --- | --- | --- |
| bolt-generator (`dojo-bolt-gen-v05.blend`) | 10.6 MB | 1.4 s | 3.5 s in worker | 24k verts / 48k tris |
| stackable-bin (`simple-bin-generator.blend`) | ~6 MB | ~1 s | 2.2 s in worker | 11k verts / 22k tris |
| bubble putty (`bubble-putty-generator.blend`) | 9.6 MB | ~1 s | **123.8 s in worker** | 100k verts / 201k tris |

### The interactive loop (slider drag on stackable-bin, auto-evaluation on)

* Continuous drag (15 moves, 80 ms apart): 1 evaluation, result arrived
  **7.1 s after the last input**.
* Drag with natural pauses (6 moves, 450 ms apart): **6 workers spawned, 5
  terminated mid-flight** after 550–770 ms of wasted boot + copy + partial
  evaluation each. The surviving result arrived **4.9 s after the last
  input** — for a tool whose warm evaluation is ~2 s.
* Every evaluation run spawns a **brand-new module Worker** and re-sends the
  **entire dump** (structured clone of ~10 MB, ~54 ms main-thread block for
  the bolt dump, plus deserialize on the worker side) even though only one
  override value changed.
* Fresh-worker vs persistent-worker A/B on identical requests (bolt dump):
  fresh 1.94–1.98 s per round; one persistent worker 1.61 → 1.46 → 1.27 s.
  Worker boot + module compile + JIT warmup costs **~0.5–0.7 s of every
  single evaluation** in dev, and warm rounds keep improving.
* The camera is re-framed (`frameAssembly()`) after **every** evaluation, so
  the viewport jumps back to the default framing on each slider change.
* Main-thread long tasks of ~200–300 ms accompany each result install
  (`showSoup` geometry + material rebuild + React re-render).

### Where the bubble-putty 124 s actually goes (CPU profile, 183 s total in Node)

| Self time | Share | What |
| --- | --- | --- |
| 67.7 s | 36.9 % | **garbage collector** |
| 30.7 s | 16.7 % | `geometry.ts` per-element lambdas |
| 18.6 s | 10.1 % | `extrudeMesh` (meshops.ts) |
| 12.0 s | 6.5 % | `computeTopology` |
| 9.4 s | 5.1 % | `Geometry.clone` |
| 8.5 s | 4.6 % | `computeVertexNormals` |

The single biggest consumer is the GC. Geometry is stored as `Vec3[]`
(`[number, number, number]` JS arrays, `src/gnvm/core.ts:11`), so every math
op allocates, every node boundary `clone()` re-allocates the whole mesh, and
the `WeakMap` caches for topology/normals (`src/gnvm/geometry.ts:384`) miss
after every clone because the mesh identity changed.

### Auto-evaluation policy vs reality

The policy (`autoEvaluationPolicyForBlendStudioTarget`) gates live editing on
a **node count** (≤ 500). Measured cost does not follow node count:

* bolt-generator: 1,153 nodes → auto-eval disabled, but evaluates in ~3.5 s.
* bubble putty: closure under 500 nodes → auto-eval **enabled**, but takes
  ~124 s per evaluation, and every slider nudge queues another one.

So the guard blocks a tool that would feel fine and green-lights the worst
tool in the set.

### Graph editor (GeometryNodesEditor)

* Every socket edit `structuredClone`s the entire dump (`commit()`), pushes
  the previous full dump onto a 40-deep undo stack, then re-runs
  `dumpGroupToEditorGraph`, rebuilds every React Flow node object, and
  `JSON.stringify`s the whole dump into `localStorage` — synchronously, on
  the main thread, per keystroke-committed edit. For 10 MB dumps that is
  hundreds of ms per edit; the bubble dump serializes to ~9.6 MB, which also
  exceeds typical localStorage quota (the `setItem` at
  `GeometryNodesEditor.tsx:336` is not wrapped in try/catch).
* Each editor change calls `onDumpChange` → `BlendBridgePage.setWorkingDump`
  → re-runs target discovery, control extraction, compatibility scoring and
  the dependency-extraction package over the whole dump.

### Initial load

Production build: the `/blendbridge` route weighs ~500 KB
(`BlendBridgePage` chunk, 160 KB gz — React Flow is bundled into it) on top
of three.js (~614 KB, 154 KB gz). Acceptable, not the bottleneck. Dev-mode
route load is ~92 module requests / ~2.5 s cold.

## What to improve, in order of impact

### 1. Reuse one warm evaluation worker and stop re-sending the dump (biggest interactive win, small change)

`mountBlendStudioRuntime.evaluate()` (`src/blend-studio/runtime.ts:887`)
creates a `new Worker` per evaluation and terminates it on completion;
`cancel()` terminates mid-flight workers on every re-queue. Instead:

* Keep **one persistent worker** per studio mount. Send the dump **once per
  import** (`{kind:"install", sourceKey, dump}`), keep it cached worker-side,
  and per evaluation send only `{sourceKey, overrides, frame, seed, …}` —
  a few hundred bytes instead of ~10 MB.
* Supersede instead of terminate: tag requests with ids and drop stale
  replies (the id plumbing already exists). Keep `terminate()` only as the
  escape hatch for runaway evaluations (the 180 s timeout path), respawning
  and re-installing the dump afterwards.
* Optional: pre-spawn the worker at import time so module compile happens
  while the user is still looking at the import summary.

Measured headroom: ~0.5–0.7 s off every evaluation, no more 5-of-6 wasted
spawns during a drag, no more 54 ms main-thread clone per nudge, and JIT
warmup compounds (1.94 s → 1.27 s by round three on the bolt dump).

### 2. Attack the evaluator's allocation churn (biggest absolute win, incremental path available)

37 % of bubble-putty's runtime is garbage collection and another ~5 % is
`Geometry.clone`. Three incremental steps, no big-bang rewrite required:

* **Copy-on-write geometry.** Most nodes read geometry and write a subset of
  it; `clone()` currently deep-copies everything. Share immutable arrays and
  copy only the mutated component (positions vs faces vs attributes). This
  also keeps mesh identity stable more often, which turns the existing
  `WeakMap` topology/normal caches from mostly-miss to mostly-hit —
  `computeTopology` + `computeVertexNormals` + `clone` are ~16 % of runtime
  today.
* **Typed-array storage for the hot fields.** Move `Mesh.positions` (and
  per-point attribute arrays) from `Vec3[]` to `Float32Array` (SoA). This
  eliminates per-element array allocations *and* gives Blender's float32
  rounding for free on store, replacing much of the pervasive
  `Math.fround` wrapping. `extrudeMesh` (10 %) and the geometry.ts
  per-element lambdas (17 %) are the first beneficiaries.
* **Cross-evaluation memoization.** `Invocation.memo`
  (`src/gnvm/evaluator.ts:710`) already memoizes per run; add a persistent
  cache keyed on `(node, upstream-override fingerprint)` so a slider that
  only affects the tail of the graph doesn't re-run the invariant 90 % of
  the closure. For tools like bubble putty, most of the 124 s is spent
  recomputing sub-graphs whose inputs did not change.

### 3. Make the auto-evaluation budget empirical, not node-count based

Keep the static gates for missing/unsupported nodes, but replace the
`> 500 nodes` heuristic with observed cost:

* Always allow the *first* explicit evaluation, record `runtimeSeconds`
  per target (it is already measured), and enable live evaluation only when
  the last run was under a threshold (e.g. 1.5 s). Disable it again —
  with the existing "Use Apply to preview" message — when a run exceeds it.
* This fixes both failure modes at once: bolt (3.5 s, currently blocked at
  1,153 nodes) could still be manual, but a future 600-node-yet-fast tool
  goes live, and bubble putty (124 s, currently *live*) stops queuing
  2-minute evaluations on every slider tick.

### 4. Stop resetting the camera on every result

`showSoup` → `frameAssembly()` (`src/blend-studio/runtime.ts:874`) recenters
and repositions the camera each evaluation. Frame only when the target
changes (`currentTargetId` already tracks this) or on explicit "frame"
action; otherwise preserve the user's orbit. This is free and removes the
most jarring perceived-performance issue while dragging sliders.

### 5. Lighten the result-install main-thread cost

* Reuse `BufferGeometry`/`BufferAttribute` objects when the new soup has the
  same layout (update `array` + `needsUpdate` instead of full dispose/
  recreate), and cache `materialFor` results per material name instead of
  building new `MeshStandardMaterial`s per group per evaluation.
* The ~200–300 ms long tasks per result will drop accordingly.

### 6. Graph editor edits should not serialize the world

* Replace the whole-dump `structuredClone` in `commit()` with a clone of the
  edited group only (undo entries can store `{groupName, before}` patches);
  cap undo memory rather than count.
* Debounce the `localStorage` draft write (e.g. 1 s idle), wrap it in
  try/catch, and skip it entirely for dumps larger than the quota — or move
  drafts to IndexedDB, which also gets the 10 MB `JSON.stringify` off the
  main thread via a worker.
* In `BlendBridgePage`, gate the `dependencyExtractionPackage` recompute on
  imports rather than every `workingDump` identity change.

### 7. Skip-level ideas worth a spike

* Run the evaluation worker pool at `navigator.hardwareConcurrency`-aware
  granularity for embarrassingly parallel nodes (per-spline lofts, per-island
  extrudes) once typed arrays make transfer/shared memory practical
  (`SharedArrayBuffer` + a small job system).
* Progressive preview: evaluate with a reduced "Resolution"-class input first
  (several No3d tools expose one) and refine when idle — Blender's own
  viewport plays the same trick with subdivision levels.

## Outcome (2026-07-27)

Recommendations 1, 2, 4 and the material-cache half of 5 were implemented on
this branch, with one architectural correction: the Float32Array storage idea
from recommendation 2 was **rejected with evidence** — mesh positions
legitimately carry double-precision values that parity fixtures assert
exactly, so float32 storage would silently re-round them. The same goal
(stop re-allocating and re-deriving everything per node and per run) was
reached through **structural sharing + copy-on-write + cross-evaluation
memoization** instead:

* `Mesh`/`Geometry.clone()` share Vec3 elements, edge pairs, face rows and
  attribute data arrays (copy-on-first-write via `ownAttributeData`);
  topology and vertex-normal caches carry over to clones.
* A persistent per-dump evaluation cache (`src/gnvm/evaluation-cache.ts`)
  re-runs only the nodes an override can reach (per-group reachability
  fixpoint; impure nodes taint downstream; zones/probes bypass; LRU-bounded).
  Five regression tests assert bit-identical parity against cold runs.
* One warm evaluation worker per studio mount; the dump is installed once
  per import and evaluations send only overrides. Runs are superseded by id
  instead of terminating the worker. Camera framing only on target change;
  materials cached per name. Numeric edge keys replace string keys in
  `extrudeMesh`/`mergeMeshInto`.

Measured on the same container as the baselines (exact vert/tri parity on
every run; all suites green — gnvm 248/248, materials 159/159,
blend-studio 36/36, tsc clean):

| Metric | Before | After |
| --- | --- | --- |
| Bubble putty cold evaluation (Node) | 182.7 s | 98.0 s |
| Bubble putty cold evaluation (browser worker) | 123.8 s | 86.3 s |
| Bubble putty warm re-eval, one override changed | ~124 s (full re-run) | **4.2 s Node / 4.0 s in-browser ("bubble density"), 1.8 s ("bottom cut")** |
| Bubble putty warm re-eval, unchanged | ~124 s | 1.3 s |
| Bubble putty warm re-eval, global "Resolution" input | ~124 s | 82.7 s (reaches ~whole graph — expected worst case) |
| Bolt generator evaluation | 3.5 s | 2.4–2.5 s |
| Workers spawned/killed during a 6-move slider drag | 6 / 5 | **0 / 0** |
| Per-nudge main-thread dump clone | ~54–82 ms | none (install-once) |
| Camera reset per evaluation | every result | target change only |

Caveats: warm-run gains depend on which input changes — an input that
reaches most of the graph (e.g. a global Resolution) still pays close to a
cold run; dumps flowing through impure nodes (Object/Collection Info,
Scene Time) intentionally get limited reuse.

### Second round (wave 4)

Three further changes, all suites green (gnvm 248/248, materials 159/159,
blend-studio 43/43, geometry-nodes 11/11, tsc clean):

* **Evaluator allocation work** (`src/gnvm/`): open-addressing edge dedup in
  `computeTopology` (self time 6.0 s → 0.5 s), allocation-free `toDomain`
  interpolation, `extrudeMesh` scratch-table reuse + incremental canonical
  topology for its output, coordinate-independent topology cache keys, and
  per-mesh corner/vertex-edge caches carried across clones. All items
  hash-verified bit-identical.
* **Empirical auto-evaluation policy** (`src/blend-studio/model.ts`): the
  `>500 nodes` rule is replaced by measured cost — runs ≤ 2 s enable live
  editing, > 4 s (or timeout/error) require explicit Apply with the measured
  time in the message, 2–4 s keeps the previous decision. History persists
  per (file fingerprint, target) so re-imports start with knowledge.
* **Graph editor commits** (`GeometryNodesEditor.tsx`): clone only the
  edited node group, patch-based undo, drafts debounced 1 s +
  quota-guarded. Per-socket-edit main-thread cost ~576 ms → ~93 ms.

| Metric | Original | After wave 2 | After wave 4 |
| --- | --- | --- | --- |
| Bubble putty cold (Node) | 182.7 s | 98.0 s | **33.5 s** |
| Bubble putty cold (browser) | 123.8 s | 86.3 s | **33.6 s** |
| Warm re-eval, one override | ~124 s | 4.2 s | **2.2 s** |
| Warm re-eval, unchanged | ~124 s | 1.3 s | 0.94 s |
| Bolt generator eval | 3.5 s | 2.4 s | 1.8 s (live editing unlocks after first Apply) |
| Graph editor per-socket edit | ~576 ms | — | ~93 ms |

Verified end-to-end in the browser on bubble putty: cold 33.6 s → policy
correctly demotes the tool to explicit Apply (no more accidental 30 s+
evaluations per slider tick) → Apply with one changed override 2.1 s →
next Apply 1.0 s → a 0.9 s run re-enables live evaluation → subsequent
slider nudges evaluate automatically in ~2.4 s. The interface now tunes
itself to each tool's measured cost.

### Third round (wave 5)

All suites green (gnvm 248/248, materials 159/159, blend-studio 48/48,
geometry-nodes 11/11, tsc clean):

* **Incremental vertex normals** (`src/gnvm/`): mutation sites now leave a
  "delta hint" (which vertices moved / were appended), and
  `vertexNormalsOf` recomputes only affected vertices in the exact
  face-major fround order of the full pass — proven bit-exact against a
  temporary cross-check of 9.04 M vertex normals over 344 incremental runs
  (0 mismatches). `computeVertexNormals` self time 4.23 s → 0.12 s; on the
  bubble tool only ~1.8 % of points actually move per repeat iteration.
* **Flat-array Topology: evaluated and rejected on evidence.** After wave 3's
  incremental topology, the full 45-consumer refactor had ≲1 s upside.
  What was actually allocating shipped surgically instead: edge-pair
  structural sharing in extrude (~12 M short arrays per run eliminated)
  and copy-on-extend vertex→edge incidence carry. GC 10.3 s → 5.2 s.
* **Progressive low-resolution preview** (`blend-studio` + page): for
  targets whose measured cost exceeds the live-edit budget and that expose
  a resolution-class input (exact-word match only), Apply first evaluates
  at a reduced value and shows it as "Low-res preview (Resolution 0.11) ·
  refining…", then refines to full quality after 500 ms of idle. Preview
  costs never enter the policy history. Verified in-browser: a Resolution
  change on bubble putty shows usable geometry **0.78 s** after Apply
  (full-quality refine lands ~38 s later, silently); fast tools never see
  a preview phase.

Same-session evaluator delta (identical machine state, bubble putty):
cold 40.25 s → **24.4 s**; warm one-override 2.9–3.4 s; warm unchanged
0.75–2.0 s; exact vert/tri parity and identical output hashes throughout.
Cumulative from the original 182.7 s cold baseline: **~7×**, and the
worst visible wait in the interface (Resolution on a slow tool) went from
~124 s of frozen "evaluating…" to a 0.78 s preview.

Remaining headroom (diminishing): fieldMap per-element math (~3.4 s),
evaluator context lambdas (~2.6 s), extrudeMesh's inherent rebuilds
(~2.4 s) — real math more than churn now; further cuts likely need
SharedArrayBuffer parallelism or algorithmic changes under the same
parity contract.

## Reproduction notes

* Interactive measurements: puppeteer scripts driving `/blendbridge` on the
  Vite dev server, uploading the dumps through the real file input, wrapping
  `Worker` to time spawn → post → reply, and reading the studio's own status
  transitions (`queued`/`evaluating`/`ready`).
* Evaluator profile: `node --cpu-prof` over `runGeometryTarget` on
  `dump_bubble.json` (target `BUBBLE VASE`, authored inputs), 183 s sampled.
