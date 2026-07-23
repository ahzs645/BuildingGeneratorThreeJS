"""Render the evaluated 2.5D Chrome Crayon under the MaterialX comparison rig."""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render_blender_references import configure_scene, look_at, write_studio_environment


def arguments() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--object", default="2.5D CHROME CRAYON OBJECT")
    parser.add_argument("--material", default="chrome.003")
    parser.add_argument("--runtime-dir", default="public/materialx/references")
    parser.add_argument("--output", default="docs/materialx-evidence/current/25d-native-blender.png")
    return parser.parse_args(argv)


def main() -> None:
    options = arguments()
    source = bpy.data.objects.get(options.object)
    material = bpy.data.materials.get(options.material)
    if source is None or material is None:
        raise RuntimeError(f"Missing source object/material: {options.object!r} / {options.material!r}")

    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = source.evaluated_get(depsgraph)
    mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
    if len(mesh.vertices) != 97_784 or len(mesh.polygons) != 97_776:
        raise RuntimeError(f"Unexpected evaluated topology: {len(mesh.vertices)} / {len(mesh.polygons)}")
    rough = mesh.attributes.get("rough")
    if rough is None or any(item.value != 0.0 for item in rough.data):
        raise RuntimeError("Exact 2.5D shader reference requires the authored rough=0 attribute")

    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    reference_scene = bpy.data.scenes.new("MaterialX 2.5D Reference")
    bpy.context.window.scene = reference_scene
    mesh.materials.clear()
    mesh.materials.append(material)
    for polygon in mesh.polygons:
        polygon.material_index = 0
    target = bpy.data.objects.new("MaterialX 2.5D Chrome Crayon", mesh)
    reference_scene.collection.objects.link(target)

    runtime = Path(options.runtime_dir).resolve()
    environment_path = runtime / "studio-environment.exr"
    irradiance_path = runtime / "studio-irradiance.exr"
    if not environment_path.exists() or not irradiance_path.exists():
        write_studio_environment(environment_path, irradiance_path)
    camera, _lights = configure_scene(environment_path)

    minimum = Vector((min(vertex.co[axis] for vertex in mesh.vertices) for axis in range(3)))
    maximum = Vector((max(vertex.co[axis] for vertex in mesh.vertices) for axis in range(3)))
    center = (minimum + maximum) * 0.5
    size = maximum - minimum
    radius = max(size.length * 0.5, 1.0)
    half_width = max(size.x, size.y, size.z, 1.0) * 0.725
    direction = Vector((1.0, -1.25, 0.85)).normalized()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = half_width * 2.0
    camera.data.lens = 50.0
    camera.location = center + direction * radius * 3.0
    camera.data.clip_start = radius / 300.0
    camera.data.clip_end = radius * 100.0
    look_at(camera, center, up=(0.0, 0.0, 1.0))

    scene = bpy.context.scene
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    scene.render.filepath = str(Path(options.output).resolve())
    Path(options.output).resolve().parent.mkdir(parents=True, exist_ok=True)
    bpy.context.view_layer.update()
    bpy.ops.render.render(write_still=True)
    print(f"MATERIALX_25D_BLENDER_REFERENCE {scene.render.filepath}")


if __name__ == "__main__":
    main()
