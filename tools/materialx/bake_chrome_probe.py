"""Bake the MaterialX Noise/Bump probe to portable tangent-normal/PBR maps.

Run with Blender 5.1 from the repository root:

  node tools/materialx/run_blender.mjs 'Chrome Crayon Surface Draw Test.blend' \
    tools/materialx/bake_chrome_probe.py -- \
    --asset-dir public/materialx/baked \
    --reference-dir docs/materialx-evidence/baked

This is original project code. It calls Blender's built-in Cycles baker and
does not contain or invoke third-party Blender add-ons.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
import MaterialX as mx

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_blender_references as reference


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset-dir", default="public/materialx/baked")
    parser.add_argument("--reference-dir", default="docs/materialx-evidence/baked")
    parser.add_argument("--texture-width", type=int, default=1024)
    parser.add_argument("--texture-height", type=int, default=512)
    return parser.parse_args(argv)


def add_probe_uvs(obj) -> None:
    """Add equirectangular UVs matching reference.probe_mesh's vertex order."""
    width_segments = 64
    height_segments = 32
    uv_layer = obj.data.uv_layers.new(name="MaterialXBakeUV")
    for polygon in obj.data.polygons:
        for loop_index in polygon.loop_indices:
            vertex_index = obj.data.loops[loop_index].vertex_index
            x = vertex_index % (width_segments + 1)
            y = vertex_index // (width_segments + 1)
            uv_layer.data[loop_index].uv = (x / width_segments, 1.0 - y / height_segments)


def new_bake_image(name: str, width: int, height: int):
    image = bpy.data.images.new(name, width=width, height=height, alpha=False, float_buffer=False)
    image.colorspace_settings.name = "Non-Color"
    image.generated_color = (0.5, 0.5, 1.0, 1.0) if "Normal" in name else (0.32, 0.32, 0.32, 1.0)
    return image


def activate_bake_target(material, image):
    node = material.node_tree.nodes.new("ShaderNodeTexImage")
    node.name = f"Bake target · {image.name}"
    node.image = image
    material.node_tree.nodes.active = node
    node.select = True
    return node


def save_png(image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.filepath_raw = str(path)
    image.file_format = "PNG"
    image.save()


def bake_maps(scene, probe, material, asset_dir: Path, width: int, height: int):
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 1
    scene.render.bake.margin = 24
    scene.render.bake.use_clear = True
    scene.render.bake.normal_space = "TANGENT"
    bpy.context.view_layer.objects.active = probe
    probe.select_set(True)

    normal = new_bake_image("Chrome Crayon Noise Normal", width, height)
    normal_node = activate_bake_target(material, normal)
    result = bpy.ops.object.bake(type="NORMAL")
    if "FINISHED" not in result:
        raise RuntimeError(f"Normal bake failed: {result}")
    normal_path = asset_dir / "chrome-crayon-noise-normal.png"
    save_png(normal, normal_path)
    material.node_tree.nodes.remove(normal_node)

    roughness = new_bake_image("Chrome Crayon Roughness", width, height)
    roughness_node = activate_bake_target(material, roughness)
    result = bpy.ops.object.bake(type="ROUGHNESS")
    if "FINISHED" not in result:
        raise RuntimeError(f"Roughness bake failed: {result}")
    roughness_path = asset_dir / "chrome-crayon-roughness.png"
    save_png(roughness, roughness_path)
    material.node_tree.nodes.remove(roughness_node)
    return normal_path, roughness_path


def baked_material(normal_path: Path, roughness_path: Path):
    material = bpy.data.materials.new("MaterialX Baked Noise/Bump Probe")
    material.use_nodes = True
    tree = material.node_tree
    principled = tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1.0)
    principled.inputs["Metallic"].default_value = 1.0

    normal_image = tree.nodes.new("ShaderNodeTexImage")
    normal_image.image = bpy.data.images.load(str(normal_path), check_existing=False)
    normal_image.image.colorspace_settings.name = "Non-Color"
    normal_map = tree.nodes.new("ShaderNodeNormalMap")
    normal_map.space = "TANGENT"
    normal_map.inputs["Strength"].default_value = 1.0
    tree.links.new(normal_image.outputs["Color"], normal_map.inputs["Color"])
    tree.links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])

    roughness_image = tree.nodes.new("ShaderNodeTexImage")
    roughness_image.image = bpy.data.images.load(str(roughness_path), check_existing=False)
    roughness_image.image.colorspace_settings.name = "Non-Color"
    tree.links.new(roughness_image.outputs["Color"], principled.inputs["Roughness"])
    return material


def render(scene, probe, material, path: Path) -> None:
    scene.render.engine = "BLENDER_EEVEE"
    probe.data.materials.clear()
    probe.data.materials.append(material)
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def load_pixels(path: Path):
    image = bpy.data.images.load(str(path), check_existing=False)
    width, height = image.size
    values = list(image.pixels[:])
    bpy.data.images.remove(image)
    return width, height, [tuple(values[index : index + 3]) for index in range(0, len(values), 4)]


def image_metrics(reference_path: Path, candidate_path: Path):
    width_a, height_a, a = load_pixels(reference_path)
    width_b, height_b, b = load_pixels(candidate_path)
    if (width_a, height_a) != (width_b, height_b):
        raise RuntimeError("Reference and baked renders have different dimensions")

    pairs = []
    radius = 0.212
    for y in range(height_a):
        ny = (y + 0.5) / height_a - 0.5
        for x in range(width_a):
            nx = (x + 0.5) / width_a - 0.5
            if nx * nx + ny * ny <= radius * radius:
                index = y * width_a + x
                pairs.append((a[index], b[index]))

    count = len(pairs)
    squared_error = sum((av - bv) ** 2 for pa, pb in pairs for av, bv in zip(pa, pb))
    absolute_error = sum(abs(av - bv) for pa, pb in pairs for av, bv in zip(pa, pb))
    luminance_a = [0.2126 * pa[0] + 0.7152 * pa[1] + 0.0722 * pa[2] for pa, _ in pairs]
    luminance_b = [0.2126 * pb[0] + 0.7152 * pb[1] + 0.0722 * pb[2] for _, pb in pairs]
    mean_a = sum(luminance_a) / count
    mean_b = sum(luminance_b) / count
    numerator = sum((av - mean_a) * (bv - mean_b) for av, bv in zip(luminance_a, luminance_b))
    denominator = math.sqrt(
        sum((value - mean_a) ** 2 for value in luminance_a)
        * sum((value - mean_b) ** 2 for value in luminance_b)
    )
    return {
        "normalizedCircleRadius": radius,
        "sampleCount": count,
        "rgbMeanAbsoluteError": round(absolute_error / (count * 3), 6),
        "rgbRootMeanSquareError": round(math.sqrt(squared_error / (count * 3)), 6),
        "luminanceCorrelation": round(numerator / denominator if denominator else 0, 6),
        "meanLuminance": {"procedural": round(mean_a, 6), "baked": round(mean_b, 6)},
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_materialx(path: Path, normal_name: str, roughness_name: str) -> tuple[bool, str]:
    text = f'''<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <nodegraph name="NG_chrome_crayon_baked">
    <image name="normal_texture" type="vector3">
      <input name="file" type="filename" value="{normal_name}" colorspace="raw" />
    </image>
    <normalmap name="tangent_normal" type="vector3">
      <input name="in" type="vector3" nodename="normal_texture" />
    </normalmap>
    <image name="roughness_texture" type="float">
      <input name="file" type="filename" value="{roughness_name}" colorspace="raw" />
    </image>
    <output name="normal" type="vector3" nodename="tangent_normal" />
    <output name="roughness" type="float" nodename="roughness_texture" />
  </nodegraph>
  <standard_surface name="SS_chrome_crayon_baked" type="surfaceshader">
    <input name="base" type="float" value="1.0" />
    <input name="base_color" type="color3" value="0.8, 0.8, 0.8" />
    <input name="metalness" type="float" value="1.0" />
    <input name="specular_roughness" type="float" nodegraph="NG_chrome_crayon_baked" output="roughness" />
    <input name="normal" type="vector3" nodegraph="NG_chrome_crayon_baked" output="normal" />
  </standard_surface>
  <surfacematerial name="ChromeCrayonBakedNoiseBump" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SS_chrome_crayon_baked" />
  </surfacematerial>
</materialx>
'''
    path.write_text(text, encoding="utf-8")
    document = mx.createDocument()
    search_path = mx.getDefaultDataSearchPath()
    libraries = mx.createDocument()
    mx.loadLibraries(mx.getDefaultDataLibraryFolders(), search_path, libraries)
    document.importLibrary(libraries)
    mx.readFromXmlFile(document, str(path), search_path)
    return document.validate()


def main() -> None:
    options = parse_args()
    asset_dir = Path(options.asset_dir).resolve()
    reference_dir = Path(options.reference_dir).resolve()
    asset_dir.mkdir(parents=True, exist_ok=True)
    reference_dir.mkdir(parents=True, exist_ok=True)

    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    environment_path = Path("public/materialx/references/studio-environment.exr").resolve()
    reference.configure_scene(environment_path)
    scene = bpy.context.scene
    probe = reference.probe_mesh()
    add_probe_uvs(probe)
    reference.floor_mesh()
    procedural = reference.bump_copy(None)
    probe.data.materials.append(procedural)

    normal_path, roughness_path = bake_maps(
        scene, probe, procedural, asset_dir, options.texture_width, options.texture_height
    )
    procedural_path = reference_dir / "noise-bump-procedural-blender.png"
    baked_path = reference_dir / "noise-bump-baked-blender.png"
    render(scene, probe, procedural, procedural_path)
    render(scene, probe, baked_material(normal_path, roughness_path), baked_path)

    mtlx_path = asset_dir / "chrome-crayon-noise-baked.mtlx"
    valid, validation_message = write_materialx(mtlx_path, normal_path.name, roughness_path.name)
    report = {
        "reportVersion": 1,
        "blenderVersion": bpy.app.version_string,
        "source": {
            "blendFile": Path(bpy.data.filepath).name,
            "blendSha256": sha256(Path(bpy.data.filepath)),
            "probe": "tools/materialx/render_blender_references.py bump_copy",
            "sourceGraph": "Position(object) * 4 -> Noise Texture 3D -> Bump(strength 0.18, distance 0.1)",
        },
        "bake": {
            "engine": "Cycles built into Blender 5.1",
            "geometry": "64 x 32 UV sphere with equirectangular MaterialXBakeUV",
            "resolution": [options.texture_width, options.texture_height],
            "marginPixels": 24,
            "normal": {"space": "tangent", "format": "8-bit PNG", "colorSpace": "Non-Color/raw"},
            "roughness": {"format": "8-bit PNG", "colorSpace": "Non-Color/raw", "sourceValue": 0.32},
        },
        "artifacts": {
            "materialx": mtlx_path.name,
            "normal": normal_path.name,
            "roughness": roughness_path.name,
            "proceduralReference": procedural_path.name,
            "bakedReference": baked_path.name,
        },
        "materialxValidation": {"valid": bool(valid), "message": validation_message},
        "comparison": image_metrics(procedural_path, baked_path),
        "provenance": {
            "code": "Original project script; no third-party add-on code",
            "baker": "Blender/Cycles; Blender is GPL-2.0-or-later and is invoked as an external authoring tool",
            "outputOwnership": "Baked maps are derived from the supplied project .blend and contain no vendored Blender code",
            "command": "node tools/materialx/run_blender.mjs 'Chrome Crayon Surface Draw Test.blend' tools/materialx/bake_chrome_probe.py -- --asset-dir public/materialx/baked --reference-dir docs/materialx-evidence/baked",
        },
    }
    report_path = reference_dir / "bake-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    if not valid:
        raise RuntimeError(f"Generated MaterialX is invalid: {validation_message}")


if __name__ == "__main__":
    main()
