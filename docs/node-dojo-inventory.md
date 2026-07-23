# Node Dojo active-root inventory

Generated with Blender 5.1.2 from `tools/node-dojo-projects.json` on 2026-07-12. The reports under `public/dojo/inventory/` are the authoritative object/modifier/root lists. For the runtime architecture, 101-entry catalog breakdown, evidence terminology, and validation workflow, start with [`NODE_DOJO_MAINTAINERS_GUIDE.md`](NODE_DOJO_MAINTAINERS_GUIDE.md).

The pack contains **16 Blender projects**, **499 active Geometry Nodes modifiers**, and **291 project-local root families**. A root family is counted once per project even when several objects use it.

These source-inventory counts are deliberately different from the **101 browser catalog entries**. The catalog contains 27 Chrome, 28 N03D, 4 New Joint, 13 Math Clay, 12 Nodes Node, 4 Send Nodes Hat, and 13 course presentation/evidence entries. Shared dumps, multiple users of one root, helper classification, and selected distinct course studies account for the difference.

| Project | Active modifiers | Root families | Current web evidence |
| --- | ---: | ---: | --- |
| Intro Module | 82 | 52 | All 11 complex studies visually closed and represented; remaining roots classified |
| New Joint Generators | 32 | 13 | Inventory complete |
| N03D 3D-printing Utilities | 77 | 39 | Inventory complete |
| Recursive Bin | 1 | 1 | Live Blender/GN-VM comparison |
| Dusty Crystal Cocoon | 2 | 1 | Active roots are Auto Smooth only |
| The Nodes Node | 17 | 12 | All 12 roots live; 6 exact/structural, 6 UI panels topology-and-bounds exact |
| Knit Graphic | 0 | 0 | No active Geometry Nodes modifier |
| Typewriter | 1 | 1 | Live GN-VM; recovered Blurmed outlines embedded, frame-240 topology/layout exact |
| Send Nodes Hat | 5 | 4 | All 4 roots live and topology-exact, including embroidery |
| Module 2 | 103 | 69 | All roots classified; shared finale live and topology/bounds exact |
| Module 3 | 28 | 20 | All roots classified; shared finale live and topology/bounds exact |
| Module 4 | 68 | 35 | All roots classified; shared finale live and topology/bounds exact |
| Chrome Crayon | 1 | 1 | Live Blender/GN-VM comparison |
| Math Clay | 33 | 14 | All 13 distinct surface roots live; shared helper represented through its consumer |
| Bubble Vessel | 6 | 3 | Live Blender/GN-VM comparison |
| Chrome Asset Library | 43 | 26 | All 26 active modifier roots represented in the browser library |

## Evidence standard for each port

A root is not considered ported merely because it evaluates without throwing. Each completed entry needs:

1. A targeted portable graph dump containing its referenced objects/collections.
2. An isolated Blender reference render.
3. Blender and GN-VM evaluated vertex/face counts.
4. Matching local-space bounds for the authored case, plus parameter cases when the root exposes meaningful controls.
5. A browser-visible entry showing Blender reference and live GN-VM output.
6. Regression tests for any new shared node semantics.

This standard is satisfied by every represented reusable root and distinct course study listed in the browser catalog; any documented residual is stated in that asset's status evidence rather than hidden by a generic completion label. The expanded acceptance criteria and completion checklist are in [`NODE_DOJO_MAINTAINERS_GUIDE.md`](NODE_DOJO_MAINTAINERS_GUIDE.md#completion-checklist).
