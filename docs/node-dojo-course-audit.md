# Node Dojo course-module root audit

Audit date: 2026-07-13. This covers the Intro and Modules 2–4 teaching scenes separately from the reusable generators in the browser gallery.

## Result

The four course projects contain **176 active project-local root families**, but they are not 176 independent products:

| Classification | Roots | Meaning |
| --- | ---: | --- |
| Instructional step | 113 | Small lesson snapshots with 5–53 reachable nodes |
| Empty/passthrough helper | 12 | Scene scaffolding rather than visible generators |
| Auto Smooth helper | 4 | Blender's standard smoothing modifier group |
| Complex study | 47 | Larger exercises, diagrams, or assembled lesson finales |

Strict recursive graph hashing collapses ten duplicate roots, leaving 166 structural families. The machine-readable root/member inventory is in `public/dojo/course-audit/status.json` and can be regenerated with `tools/audit-course-roots.mjs` after extracting the four scene dumps.

## Blender/browser samples

- Intro `Plane.023` / `geo` is a 1,181-node “CHALLENGE!” text exercise. Blender evaluates 2,331 vertices / 16 faces. The browser executes the graph, but portable font substitution and curve-fill layout do not yet reproduce the authored typography.
- Intro `Cube.014` / `Geometry Nodes.023` is a 1,130-node diagram of two Geometry Nodes panels. Blender evaluates 104,454 / 44,423; the browser evaluates the same branches but its legacy text, row, and panel placement are compressed, matching the remaining limitations documented for The Nodes Node UI roots.
- The `dojo` finale in Modules 2–4 is the same authored banner-and-medallion study saved in successive course scenes. Blender evaluates 47,435 / 46,490 in each file. The GN-VM now has handlers for every reachable node type, including Shortest Edge Paths and Edge Paths to Curves, but evaluates 56,605 / 53,491 and selects the building-facade lesson branch instead of the two banners. It is therefore **100% handler-covered but visually divergent**.

## Porting decision

Course roots remain authoritative teaching snapshots, not missing catalog products. We will publish a course root only when it represents a distinct visible exercise and passes the same Blender-reference standard as the reusable generators. Repeated lesson stages and helper roots stay in the audit inventory so they are not mistaken for unfinished products.

The next semantic investigation for the Modules 2–4 finale is the field/domain or object-dependency selection that chooses the building branch. Adding more node stubs will not fix it: the reachable handler coverage is already complete.
