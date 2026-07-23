"""Render matched Blender Eevee references for the MaterialX lab probe."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


def args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-dir", default="public/materialx/references")
    parser.add_argument("--evidence-dir", default="docs/materialx-evidence/current")
    parser.add_argument("--material", default="chrome.003")
    parser.add_argument("--ui-report", default="public/materialx/ui-normal-band.report.json")
    return parser.parse_args(argv)


def look_at(obj, target=(0.0, 0.0, 0.0), up=(0.0, 1.0, 0.0)) -> None:
    position = obj.location.copy()
    forward = (Vector(target) - position).normalized()
    right = forward.cross(Vector(up)).normalized()
    actual_up = right.cross(forward).normalized()
    rotation = Matrix((right, actual_up, -forward)).transposed().to_4x4()
    rotation.translation = position
    obj.matrix_world = rotation


def probe_mesh(width_segments=64, height_segments=32):
    vertices = []
    faces = []
    for y in range(height_segments + 1):
        v = y / height_segments
        phi = v * math.pi
        for x in range(width_segments + 1):
            u = x / width_segments
            theta = u * math.pi * 2.0
            vertices.append((math.sin(phi) * math.cos(theta), math.cos(phi), math.sin(phi) * math.sin(theta)))
    for y in range(height_segments):
        for x in range(width_segments):
            a = y * (width_segments + 1) + x
            b = a + width_segments + 1
            if y != 0:
                faces.append((a, a + 1, b))
            if y != height_segments - 1:
                faces.append((b, a + 1, b + 1))
    mesh = bpy.data.meshes.new("MaterialXProbe")
    mesh.from_pydata(vertices, [], faces)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    rough = mesh.attributes.new("rough", "FLOAT", "POINT")
    for item in rough.data:
        item.value = 0.8
    col = mesh.attributes.new("col", "FLOAT_COLOR", "POINT")
    for item, vertex in zip(col.data, mesh.vertices):
        item.color = tuple((component + 1.0) * 0.5 for component in vertex.co) + (1.0,)
    obj = bpy.data.objects.new("MaterialXProbe", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.rotation_euler[1] = -0.38
    return obj


def floor_mesh():
    segments = 96
    vertices = [(0.0, -1.12, 0.0)] + [
        (3.4 * math.cos(index * 2 * math.pi / segments), -1.12, 3.4 * math.sin(index * 2 * math.pi / segments))
        for index in range(segments)
    ]
    faces = [(0, (index + 1) % segments + 1, index + 1) for index in range(segments)]
    mesh = bpy.data.meshes.new("MaterialXFloor")
    mesh.from_pydata(vertices, [], faces)
    obj = bpy.data.objects.new("MaterialXFloor", mesh)
    bpy.context.scene.collection.objects.link(obj)
    material = bpy.data.materials.new("MaterialXFloor")
    material.diffuse_color = (0.0185, 0.0232, 0.0267, 1.0)
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (0.0185, 0.0232, 0.0267, 1.0)
    principled.inputs["Roughness"].default_value = 0.82
    mesh.materials.append(material)


def add_sun(name, position, color, energy):
    data = bpy.data.lights.new(name, "SUN")
    data.color = color
    data.energy = energy
    data.angle = math.radians(8)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    look_at(obj)
    return obj


def write_float_exr(path: Path, name: str, width: int, height: int, pixels: list[float]):
    image = bpy.data.images.new(name, width=width, height=height, alpha=True, float_buffer=True)
    image.pixels.foreach_set(pixels)
    image.filepath_raw = str(path)
    image.file_format = "OPEN_EXR"
    image.save()
    bpy.data.images.remove(image)


def sh_basis(direction):
    """Third-order real SH basis in MaterialX's lat-long coordinate frame."""
    x, y, z = direction
    return (
        math.sqrt(1.0 / (4.0 * math.pi)),
        math.sqrt(3.0 / (4.0 * math.pi)) * y,
        math.sqrt(3.0 / (4.0 * math.pi)) * z,
        math.sqrt(3.0 / (4.0 * math.pi)) * x,
        math.sqrt(15.0 / (4.0 * math.pi)) * x * y,
        math.sqrt(15.0 / (4.0 * math.pi)) * y * z,
        math.sqrt(5.0 / (16.0 * math.pi)) * (3.0 * z * z - 1.0),
        math.sqrt(15.0 / (4.0 * math.pi)) * x * z,
        math.sqrt(15.0 / (16.0 * math.pi)) * (x * x - y * y),
    )


def latlong_direction(x: int, y: int, width: int, height: int):
    theta = math.pi * (y + 0.5) / height
    phi = 2.0 * math.pi * (x + 0.5) / width
    radius = math.sin(theta)
    return (-radius * math.sin(phi), -math.cos(theta), radius * math.cos(phi))


def write_irradiance(path: Path, radiance: list[float], width: int, height: int):
    """Project radiance to the same third-order cosine-convolved SH used by MaterialX."""
    coefficients = [[0.0, 0.0, 0.0] for _ in range(9)]
    for y in range(height):
        solid_angle = (math.cos(y * math.pi / height) - math.cos((y + 1) * math.pi / height)) * 2.0 * math.pi / width
        for x in range(width):
            basis = sh_basis(latlong_direction(x, y, width, height))
            offset = (y * width + x) * 4
            color = radiance[offset : offset + 3]
            for coefficient, weight in zip(coefficients, basis):
                for channel in range(3):
                    coefficient[channel] += color[channel] * solid_angle * weight
    cosine_factors = (1.0, 2.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0, 0.25, 0.25, 0.25, 0.25, 0.25)
    for coefficient, factor in zip(coefficients, cosine_factors):
        for channel in range(3):
            coefficient[channel] *= factor

    output_width, output_height = 64, 32
    output = []
    for y in range(output_height):
        for x in range(output_width):
            basis = sh_basis(latlong_direction(x, y, output_width, output_height))
            color = [
                max(0.0, sum(coefficients[index][channel] * basis[index] for index in range(9)))
                for channel in range(3)
            ]
            output.extend((*color, 1.0))
    write_float_exr(path, "MaterialXStudioIrradiance", output_width, output_height, output)


def write_studio_environment(path: Path, irradiance_path: Path):
    """Write linear radiance and Apache MaterialX-compatible irradiance maps."""
    width, height = 256, 128
    panels = (
        (0.24, 0.38, 0.075, 0.14, (3.2, 4.8, 8.0)),
        (0.50, 0.30, 0.10, 0.11, (8.0, 8.0, 8.0)),
        (0.77, 0.40, 0.075, 0.14, (8.0, 4.8, 2.6)),
        (0.50, 0.78, 0.24, 0.035, (1.2, 1.2, 1.2)),
    )
    pixels = []
    for y in range(height):
        v = (y + 0.5) / height
        for x in range(width):
            u = (x + 0.5) / width
            horizon = 0.018 + 0.025 * max(0.0, 1.0 - abs(v - 0.55) * 3.0)
            color = [horizon, horizon, horizon]
            for center_u, center_v, half_u, half_v, panel_color in panels:
                du = min(abs(u - center_u), 1.0 - abs(u - center_u)) / half_u
                dv = abs(v - center_v) / half_v
                weight = math.exp(-((du ** 8) + (dv ** 8)))
                for channel in range(3):
                    color[channel] += panel_color[channel] * weight
            pixels.extend((*color, 1.0))
    path.parent.mkdir(parents=True, exist_ok=True)
    write_float_exr(path, "MaterialXStudioEnvironment", width, height, pixels)
    write_irradiance(irradiance_path, pixels, width, height)


def configure_scene(environment_path: Path):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    world = bpy.data.worlds.new("MaterialXWorld")
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()
    environment = nodes.new("ShaderNodeTexEnvironment")
    environment.image = bpy.data.images.load(str(environment_path), check_existing=False)
    environment.image.colorspace_settings.name = "Linear Rec.709"
    reflected = nodes.new("ShaderNodeBackground")
    reflected.name = "MaterialXReflectedEnvironment"
    reflected.inputs["Strength"].default_value = 0.18
    camera_background = nodes.new("ShaderNodeBackground")
    camera_background.inputs["Color"].default_value = (0.0056, 0.0070, 0.0084, 1.0)
    camera_background.inputs["Strength"].default_value = 1.0
    light_path = nodes.new("ShaderNodeLightPath")
    mix = nodes.new("ShaderNodeMixShader")
    output = nodes.new("ShaderNodeOutputWorld")
    links.new(environment.outputs["Color"], reflected.inputs["Color"])
    links.new(light_path.outputs["Is Camera Ray"], mix.inputs[0])
    links.new(reflected.outputs[0], mix.inputs[1])
    links.new(camera_background.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], output.inputs[0])
    scene.world = world

    camera_data = bpy.data.cameras.new("MaterialXCamera")
    camera_data.sensor_fit = "VERTICAL"
    camera_data.sensor_height = 32
    camera_data.lens = 32 / (2 * math.tan(math.radians(25)))
    camera = bpy.data.objects.new("MaterialXCamera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera.location = (3.2, 2.2, 3.4)
    look_at(camera)
    scene.camera = camera
    lights = [
        add_sun("Key", (4, 5, 3), (1.0, 1.0, 1.0), 3.2),
        add_sun("Fill", (-4, 2, 2), (0.266, 0.48, 1.0), 1.4),
        add_sun("Rim", (1, 1, -4), (1.0, 0.578, 0.319), 1.8),
    ]
    bpy.context.view_layer.update()
    return camera, lights


def matrix_rows(matrix):
    return [[float(matrix[row][column]) for column in range(4)] for row in range(4)]


def direction_from_local_axis(obj, axis):
    return list((obj.matrix_world.to_3x3() @ Vector(axis)).normalized())


def write_scene_contract(path: Path, camera, lights, probe):
    contract = {
        "schemaVersion": 1,
        "source": "Blender 5.1.2 evaluated matrix_world",
        "coordinateSystem": {
            "blenderWorld": "right-handed Z-up",
            "probeConvention": "geometry and camera deliberately use world +Y as visual up",
            "sunPropagationAxis": "evaluated local -Z",
            "materialXLightData": "direction is propagation direction; generated directional shader negates it",
        },
        "camera": {
            "matrixWorldRows": matrix_rows(camera.matrix_world),
            "right": direction_from_local_axis(camera, (1.0, 0.0, 0.0)),
            "up": direction_from_local_axis(camera, (0.0, 1.0, 0.0)),
            "back": direction_from_local_axis(camera, (0.0, 0.0, 1.0)),
            "forward": direction_from_local_axis(camera, (0.0, 0.0, -1.0)),
            "verticalFovDegrees": math.degrees(camera.data.angle_y),
        },
        "lights": [],
        "probe": {
            "bounds": {
                "space": "object",
                "min": [min(vertex.co[index] for vertex in probe.data.vertices) for index in range(3)],
                "max": [max(vertex.co[index] for vertex in probe.data.vertices) for index in range(3)],
            },
            "geometryProperties": [
                {"name": "rough", "type": "float", "domain": "point"},
                {"name": "col", "type": "color3", "domain": "point"},
            ],
        },
    }
    for light in lights:
        propagation = Vector(direction_from_local_axis(light, (0.0, 0.0, -1.0)))
        contract["lights"].append({
            "name": light.name.lower(),
            "matrixWorldRows": matrix_rows(light.matrix_world),
            "propagationDirection": list(propagation),
            "toLightDirection": list(-propagation),
            "color": list(light.data.color),
            "intensity": float(light.data.energy),
            "angleDegrees": math.degrees(light.data.angle),
        })
    path.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")


def smooth_chrome():
    material = bpy.data.materials.new("MaterialX Smooth Chrome Diagnostic")
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1.0)
    principled.inputs["Metallic"].default_value = 1.0
    principled.inputs["Roughness"].default_value = 0.32
    return material


def input_by_identifier(node, identifier):
    return next(socket for socket in node.inputs if socket.identifier == identifier)


def output_by_identifier(node, identifier):
    return next(socket for socket in node.outputs if socket.identifier == identifier)


def ui_normal_band_diagnostic(report_path: Path):
    report = json.loads(report_path.read_text(encoding="utf-8"))
    lowering = report["diagnosticLowering"]
    property_name = report["activeGraph"]["geometryProperties"][0]["name"]
    material = bpy.data.materials.new("MaterialX UI Normal Band Semantic Diagnostic")
    material.use_nodes = True
    tree = material.node_tree
    tree.nodes.clear()
    texcoord = tree.nodes.new("ShaderNodeTexCoord")
    mapping = tree.nodes.new("ShaderNodeMapping")
    mapping.vector_type = "POINT"
    mapping.inputs["Rotation"].default_value = lowering["rotationRadians"]
    ramp = tree.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    while len(ramp.color_ramp.elements) > 1:
        ramp.color_ramp.elements.remove(ramp.color_ramp.elements[-1])
    first = lowering["constantRamp"][0]
    ramp.color_ramp.elements[0].position = first["position"]
    ramp.color_ramp.elements[0].color = (*first["color"], 1.0)
    for entry in lowering["constantRamp"][1:]:
        element = ramp.color_ramp.elements.new(entry["position"])
        element.color = (*entry["color"], 1.0)
    attribute = tree.nodes.new("ShaderNodeAttribute")
    attribute.attribute_type = "GEOMETRY"
    attribute.attribute_name = property_name
    mix = tree.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    input_by_identifier(mix, "Factor_Float").default_value = lowering["mixFactor"]
    emission = tree.nodes.new("ShaderNodeEmission")
    output = tree.nodes.new("ShaderNodeOutputMaterial")
    tree.links.new(texcoord.outputs["Normal"], mapping.inputs["Vector"])
    tree.links.new(mapping.outputs["Vector"], ramp.inputs["Fac"])
    tree.links.new(ramp.outputs["Color"], input_by_identifier(mix, "A_Color"))
    tree.links.new(attribute.outputs["Color"], input_by_identifier(mix, "B_Color"))
    tree.links.new(output_by_identifier(mix, "Result_Color"), emission.inputs["Color"])
    tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def render_light_diagnostics(output: Path, probe, lights):
    probe.data.materials[0] = smooth_chrome()
    environment = bpy.context.scene.world.node_tree.nodes["MaterialXReflectedEnvironment"]
    original_environment_strength = environment.inputs["Strength"].default_value
    environment.inputs["Strength"].default_value = 0.0
    original_energies = {light.name: light.data.energy for light in lights}
    original_angles = {light.name: light.data.angle for light in lights}
    for selected in lights:
        for light in lights:
            light.data.energy = original_energies[light.name] if light == selected else 0.0
            light.data.angle = 0.0
        bpy.context.scene.render.filepath = str(output / f"light-{selected.name.lower()}-blender.png")
        bpy.ops.render.render(write_still=True)
    environment.inputs["Strength"].default_value = original_environment_strength
    for light in lights:
        light.data.energy = original_energies[light.name]
        light.data.angle = original_angles[light.name]


def bump_copy(_source):
    material = bpy.data.materials.new("MaterialX Noise Bump Probe")
    material.use_nodes = True
    material.name = "MaterialX Noise Bump Probe"
    tree = material.node_tree
    principled = tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1.0)
    principled.inputs["Metallic"].default_value = 1.0
    principled.inputs["Roughness"].default_value = 0.32
    geometry = tree.nodes.new("ShaderNodeNewGeometry")
    mapping = tree.nodes.new("ShaderNodeVectorMath")
    mapping.operation = "SCALE"
    mapping.inputs[3].default_value = 4.0
    noise = tree.nodes.new("ShaderNodeTexNoise")
    noise.noise_dimensions = "3D"
    noise.inputs["Scale"].default_value = 1.0
    noise.inputs["Detail"].default_value = 2.0
    noise.inputs["Roughness"].default_value = 0.5
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.18
    bump.inputs["Distance"].default_value = 0.1
    tree.links.new(geometry.outputs["Position"], mapping.inputs[0])
    tree.links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], principled.inputs["Normal"])
    return material


def main():
    options = args()
    runtime = Path(options.runtime_dir).resolve()
    evidence = Path(options.evidence_dir).resolve()
    runtime.mkdir(parents=True, exist_ok=True)
    evidence.mkdir(parents=True, exist_ok=True)
    environment_path = runtime / "studio-environment.exr"
    irradiance_path = runtime / "studio-irradiance.exr"
    write_studio_environment(environment_path, irradiance_path)
    source = bpy.data.materials.get(options.material)
    if source is None:
        raise RuntimeError(f"Missing source material {options.material!r}")
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    camera, lights = configure_scene(environment_path)
    probe = probe_mesh()
    write_scene_contract(runtime / "scene-contract.json", camera, lights, probe)
    floor_mesh()
    source.use_nodes = True
    probe.data.materials.append(source)
    bpy.context.scene.render.filepath = str(evidence / "chrome-source-blender.png")
    bpy.ops.render.render(write_still=True)
    probe.data.materials[0] = bump_copy(source)
    bpy.context.scene.render.filepath = str(evidence / "noise-bump-blender.png")
    bpy.ops.render.render(write_still=True)
    # Keep this branch diagnostic on an identity-transformed probe. The browser
    # capability report records the world-to-object normal substitution, and at
    # identity the coordinate spaces are equivalent for an honest branch check.
    probe.rotation_euler[1] = 0.0
    bpy.context.view_layer.update()
    probe.data.materials[0] = ui_normal_band_diagnostic(Path(options.ui_report).resolve())
    bpy.context.scene.render.filepath = str(evidence / "ui-normal-band-blender.png")
    bpy.ops.render.render(write_still=True)
    probe.rotation_euler[1] = -0.38
    bpy.context.view_layer.update()
    render_light_diagnostics(evidence, probe, lights)
    print(f"MATERIALX_BLENDER_REFERENCES {evidence}")


if __name__ == "__main__":
    main()
