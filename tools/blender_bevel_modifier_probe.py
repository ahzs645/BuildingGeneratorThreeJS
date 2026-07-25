"""Report deterministic topology for one saved Blender Bevel modifier.

Usage:
  blender --background FILE.blend \
    --python tools/blender_bevel_modifier_probe.py -- OBJECT MODIFIER

The probe intentionally mutates only Blender's in-memory modifier. It is a
small truth harness for the browser modifier kernel and never saves the source
project.
"""

import json
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) != 2:
    raise RuntimeError("expected OBJECT MODIFIER")

object_name, modifier_name = args
obj = bpy.data.objects.get(object_name)
if obj is None:
    raise RuntimeError(f'object not found: "{object_name}"')
modifier = obj.modifiers.get(modifier_name)
if modifier is None or modifier.type != "BEVEL":
    raise RuntimeError(f'Bevel modifier not found: "{modifier_name}"')


def evaluated_stats():
    depsgraph = bpy.context.evaluated_depsgraph_get()
    depsgraph.update()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        return {
            "verts": len(mesh.vertices),
            "edges": len(mesh.edges),
            "faces": len(mesh.polygons),
            "triangles": len(mesh.loop_triangles),
        }
    finally:
        evaluated.to_mesh_clear()


properties = {}
for prop in modifier.bl_rna.properties:
    identifier = prop.identifier
    if identifier == "rna_type" or prop.is_readonly:
        continue
    value = getattr(modifier, identifier)
    if isinstance(value, (bool, int, float, str)):
        properties[identifier] = value

segment_sweep = []
saved_segments = modifier.segments
for segments in (1, 2, 3, 4, 5, 10):
    modifier.segments = segments
    segment_sweep.append({"segments": segments, **evaluated_stats()})
modifier.segments = saved_segments

print(
    "NODE_DOJO_BEVEL_PROBE "
    + json.dumps(
        {
            "object": object_name,
            "modifier": modifier_name,
            "properties": properties,
            "segment_sweep": segment_sweep,
        },
        sort_keys=True,
    )
)
