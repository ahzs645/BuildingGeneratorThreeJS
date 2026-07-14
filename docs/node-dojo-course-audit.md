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
- The `dojo` finale in Modules 2–4 is the same authored banner-and-medallion study saved in successive course scenes. Muted-link extraction now excludes the four inactive building-lesson links, Subdivide Mesh evaluates inside the banner instances, and poly-to-Bézier conversion preserves the medallion's authored outline density. Blender and the browser both evaluate **47,435 vertices / 46,490 faces / 93,121 triangles**, with the same face-size distribution and local bounds. Small procedural wind-displacement and Workbench shading differences remain.

## Porting decision

Course roots remain authoritative teaching snapshots, not missing catalog products. We will publish a course root only when it represents a distinct visible exercise and passes the same Blender-reference standard as the reusable generators. Repeated lesson stages and helper roots stay in the audit inventory so they are not mistaken for unfinished products.

The canonical Modules 2–4 finale now meets the publication evidence standard and is live in the browser library. The next course work should select another distinct visible complex study rather than expanding duplicated lesson snapshots.
