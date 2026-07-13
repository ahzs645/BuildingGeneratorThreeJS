# N03D active-root classification

Audit date: 2026-07-13. Source: `public/dojo/n03d/root-audit.json`.

The N03D file has 39 active Geometry Nodes roots, but they are not 39 separate products. Twenty-seven roots are published or intentionally represented in the 87-entry browser library. Five are saved duplicates or equivalent source-geometry variants, six are empty/placeholder/stacked helpers, and one is a genuinely distinct unresolved parity target.

The complete machine-readable mapping is in `public/dojo/n03d/root-classification.json`. This prevents duplicate datablocks and stacked modifier counts from being mistaken for missing generators.

## Remaining distinct target

`BOLT GEN DHTS v03_Thru Head_1JUL2024.005` adds the saved `watertighten` branch and is materially different from the published main Bolt root. In a local-space authored comparison:

- Blender: 16,588 vertices / 16,590 faces.
- GN-VM: 83,796 vertices / 42,020 faces.
- GN-VM evaluation: about 166 seconds.

The browser result is visibly divergent around the boolean-closed thread and end cap, so this variant is classified as an open parity target rather than being published as if it were complete.

The `.001` and `.002` compact Bolt roots are not separate targets: both contain the same 59-node root shape and the same saved modifier values. Their only measured difference is the source profile's Z placement. The old v02 active root produces one loose point and no surface.

## Interpretation rules

- `published` means a catalog entry and status report exist.
- `represented-placeholder` means the saved wrapper is intentionally replaced by its authored nested product group, as with Split n Tap.
- `duplicate-root`, `duplicate-preset`, and `family-variant` preserve inventory evidence without adding redundant catalog entries.
- `empty-helper` and `stacked-helper` are not visible standalone generators in Blender.
- `open-parity-target` is distinct and still requires semantic/performance work.
