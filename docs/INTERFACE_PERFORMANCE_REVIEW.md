# Interface Performance Review — BlendBridge Studio with the No3d Tools

Date: 2026-07-26
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

## Reproduction notes

* Interactive measurements: puppeteer scripts driving `/blendbridge` on the
  Vite dev server, uploading the dumps through the real file input, wrapping
  `Worker` to time spawn → post → reply, and reading the studio's own status
  transitions (`queued`/`evaluating`/`ready`).
* Evaluator profile: `node --cpu-prof` over `runGeometryTarget` on
  `dump_bubble.json` (target `BUBBLE VASE`, authored inputs), 183 s sampled.
