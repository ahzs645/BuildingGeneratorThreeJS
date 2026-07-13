# N03D active-root classification

Audit date: 2026-07-13. Source: `public/dojo/n03d/root-audit.json`.

The N03D file has 39 active Geometry Nodes roots, but they are not 39 separate products. Twenty-eight roots are published or intentionally represented in the 88-entry browser library. Five are saved duplicates or equivalent source-geometry variants, and six are empty/placeholder/stacked helpers. Every distinct active product root is now represented.

The complete machine-readable mapping is in `public/dojo/n03d/root-classification.json`. This prevents duplicate datablocks and stacked modifier counts from being mistaken for missing generators.

## Final distinct target

`BOLT GEN DHTS v03_Thru Head_1JUL2024.005` adds the saved `watertighten` branch and is materially different from the original published Bolt root. It is now published as `n03d-bolt-watertight`. In the authored 13-pass comparison:

- Blender: 16,570 vertices / 16,572 faces.
- GN-VM: 16,774 vertices / 16,776 faces.
- GN-VM evaluation: about 68 seconds.

Both outputs are closed manifolds with matching healed thread silhouette. The 1.23% topology difference comes from OpenVDB versus the browser surface-net cell placement; local bounds are within 0.012 units before the supplied object's residual Z placement.

The `.001` and `.002` compact Bolt roots are not separate targets: both contain the same 59-node root shape and the same saved modifier values. Their only measured difference is the source profile's Z placement. The old v02 active root produces one loose point and no surface.

## Interpretation rules

- `published` means a catalog entry and status report exist.
- `represented-placeholder` means the saved wrapper is intentionally replaced by its authored nested product group, as with Split n Tap.
- `duplicate-root`, `duplicate-preset`, and `family-variant` preserve inventory evidence without adding redundant catalog entries.
- `empty-helper` and `stacked-helper` are not visible standalone generators in Blender.
- `open-parity-target` is distinct and still requires semantic/performance work.
