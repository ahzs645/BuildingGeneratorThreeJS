"""Extract one Blender material through Blender 5.1's native USD/MaterialX graph.

Run with Blender, not system Python:
  blender -b source.blend --python tools/materialx/extract_blender_material.py -- \
    --material chrome.003 --output public/materialx/chrome-crayon-native.mtlx \
    --report public/materialx/chrome-crayon-native.report.json

The script contains no code from third-party Blender add-ons. It translates the
native USDShade MaterialX network to standalone MaterialX XML and normalizes
OpenPBR surface inputs to the Standard Surface names consumed by Three r185.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import bpy
import MaterialX as mx
from pxr import Usd, UsdShade


TYPE_MAP = {
    "bool": "boolean",
    "color3f": "color3",
    "color4f": "color4",
    "float": "float",
    "float2": "vector2",
    "float3": "vector3",
    "float4": "vector4",
    "int": "integer",
    "asset": "filename",
    "token": "string",
    "string": "string",
}

OPEN_PBR_TO_STANDARD_SURFACE = {
    "base_weight": "base",
    "base_color": "base_color",
    "base_metalness": "metalness",
    "specular_weight": "specular",
    "specular_color": "specular_color",
    "specular_roughness": "specular_roughness",
    "specular_ior": "specular_IOR",
    "specular_roughness_anisotropy": "specular_anisotropy",
    "transmission_weight": "transmission",
    "transmission_color": "transmission_color",
    "coat_weight": "coat",
    "coat_roughness": "coat_roughness",
    "coat_color": "coat_color",
    "fuzz_weight": "sheen",
    "fuzz_color": "sheen_color",
    "fuzz_roughness": "sheen_roughness",
    "thin_film_thickness": "thin_film_thickness",
    "thin_film_ior": "thin_film_IOR",
    "geometry_opacity": "opacity",
    "geometry_normal": "normal",
    "emission_color": "emission_color",
    "emission_luminance": "emission",
}

STANDARD_SURFACE_INPUT_TYPES = {
    "opacity": "color3",
}


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--material", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--geometry-contract")
    parser.add_argument("--keep-native-usd", action="store_true")
    return parser.parse_args(argv)


def sanitize(value: str) -> str:
    result = re.sub(r"[^A-Za-z0-9_]", "_", value)
    return result if result and not result[0].isdigit() else f"n_{result}"


def format_value(value) -> str:
    if hasattr(value, "path"):
        return value.path
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (tuple, list)) or hasattr(value, "__len__") and not isinstance(value, str):
        return ", ".join(format_value(component) for component in value)
    if isinstance(value, float):
        return format(value, ".9g")
    return str(value)


def usd_type(attribute) -> str:
    return TYPE_MAP.get(str(attribute.GetTypeName()), str(attribute.GetTypeName()))


def make_probe(material: bpy.types.Material) -> None:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    mesh = bpy.data.meshes.new("MaterialXExtractionProbe")
    mesh.from_pydata([(-1.0, -1.0, 0.0), (1.0, -1.0, 0.0), (0.0, 1.0, 0.0)], [], [(0, 1, 2)])
    obj = bpy.data.objects.new("MaterialXExtractionProbe", mesh)
    bpy.context.scene.collection.objects.link(obj)
    mesh.materials.append(material)


def export_native_usd(material: bpy.types.Material, path: Path) -> None:
    make_probe(material)
    result = bpy.ops.wm.usd_export(
        filepath=str(path),
        export_animation=False,
        export_materials=True,
        generate_preview_surface=False,
        generate_materialx_network=True,
        relative_paths=True,
        export_textures_mode="NEW",
    )
    if "FINISHED" not in result:
        raise RuntimeError(f"Blender USD export failed: {result}")


def clean_previous_dependencies(report_path: Path, output: Path) -> None:
    if not report_path.is_file():
        return
    previous = json.loads(report_path.read_text(encoding="utf-8"))
    for relative_name in previous.get("textures", []):
        candidate = (output.parent / relative_name).resolve()
        if output.parent.resolve() not in candidate.parents:
            raise RuntimeError(f"Refusing to clean texture outside output directory: {candidate}")
        if candidate.is_file():
            candidate.unlink()


def copy_texture_dependencies(native_usd: Path, output: Path, material_name: str) -> list[str]:
    """Copy only assets reachable from the selected material's USD subtree."""
    stage = Usd.Stage.Open(str(native_usd))
    selected_material = material_prim(stage, material_name)
    relative_paths = set()
    for prim in Usd.PrimRange(selected_material):
        for attribute in prim.GetAttributes():
            value = attribute.Get()
            asset_path = getattr(value, "path", "")
            if not asset_path:
                continue
            relative = Path(asset_path)
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError(f"Native exporter produced a non-portable asset path: {asset_path}")
            relative_paths.add(relative)

    copied = []
    for relative in sorted(relative_paths):
        source = native_usd.parent / relative
        if not source.is_file():
            raise RuntimeError(f"Material texture dependency was not exported: {relative}")
        destination = output.parent / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.resolve() != destination.resolve():
            shutil.copy2(source, destination)
        copied.append(relative.as_posix())
    return copied


def material_prim(stage: Usd.Stage, material_name: str):
    for prim in stage.Traverse():
        if prim.GetTypeName() != "Material":
            continue
        authored = prim.GetAttribute("userProperties:blender:data_name").Get()
        if authored == material_name or prim.GetName() == sanitize(material_name):
            return prim
    raise RuntimeError(f"Native USD did not contain material {material_name!r}")


def shader_id(prim) -> str:
    return str(prim.GetAttribute("info:id").Get() or "")


def node_category_and_type(prim) -> tuple[str, str]:
    identifier = shader_id(prim)
    if not identifier.startswith("ND_"):
        return identifier, "float"
    body = identifier[3:]
    output = prim.GetAttribute("outputs:out")
    node_type = usd_type(output) if output else "float"
    suffix = {
        "_color3": "color3", "_color4": "color4", "_vector2": "vector2", "_vector3": "vector3",
        "_vector4": "vector4", "_float": "float", "_integer": "integer", "_boolean": "boolean",
    }
    category = body
    for ending, declared_type in suffix.items():
        if body.endswith(ending):
            category = body[: -len(ending)]
            if not output:
                node_type = declared_type
            break
    if category.startswith("convert_"):
        category = "convert"
    return category, node_type


def source_connection(attribute):
    connections = attribute.GetConnections()
    if not connections:
        return None
    path = connections[0]
    source_prim = attribute.GetPrim().GetStage().GetPrimAtPath(path.GetPrimPath())
    if source_prim.GetTypeName() == "NodeGraph":
        forwarded = source_prim.GetAttribute(str(path.name))
        return source_connection(forwarded) if forwarded else None
    output_name = path.name.split(":")[-1]
    return source_prim.GetName(), output_name


def append_usd_inputs(parent: ET.Element, prim) -> None:
    for attribute in prim.GetAttributes():
        name = attribute.GetName()
        if not name.startswith("inputs:"):
            continue
        input_name = name.split(":", 1)[1]
        connection = source_connection(attribute)
        value = attribute.Get()
        if input_name == "space" and value is not None:
            parent.set("space", str(value))
            continue
        if not connection and value is None:
            continue
        child = ET.SubElement(parent, "input", name=input_name, type=usd_type(attribute))
        if connection:
            child.set("nodename", sanitize(connection[0]))
            if connection[1] != "out":
                child.set("output", connection[1])
        elif value is not None:
            child.set("value", format_value(value))


def add_nodegraph(root: ET.Element, graph_prim) -> tuple[ET.Element, dict[str, str]]:
    graph = ET.SubElement(root, "nodegraph", name="NG_blender_native")
    categories = {}
    for prim in graph_prim.GetChildren():
        if prim.GetTypeName() != "Shader":
            continue
        category, node_type = node_category_and_type(prim)
        categories[prim.GetName()] = category
        node = ET.SubElement(graph, category, name=sanitize(prim.GetName()), type=node_type)
        append_usd_inputs(node, prim)
    return graph, categories


def recover_generated_coordinates(graph: ET.Element, categories: dict[str, str]) -> int:
    """Replace Blender's vector2 texcoord surrogate with Generated semantics.

    Blender lowers Texture Coordinate / Generated to a UV texcoord followed by
    a vector3 convert in its native USD network. Generated is instead the
    object-space position normalized by the evaluated object's local bounds.
    Keep those bounds as graph-interface inputs so the renderer can bind them
    per object; do not bake probe-specific bounds into the material.
    """
    recovered = 0
    for native_name, category in categories.items():
        if category != "texcoord" or not native_name.endswith("_Generated"):
            continue
        target = sanitize(native_name)
        texcoord = next((child for child in graph if child.get("name") == target), None)
        if texcoord is None:
            continue

        consumers = [
            child for child in graph
            if child.tag == "convert"
            and child.get("type") == "vector3"
            and any(input_.get("nodename") == target for input_ in child.findall("input"))
        ]
        direct_references = [
            input_ for child in graph for input_ in child.findall("input")
            if input_.get("nodename") == target
        ]
        if len(consumers) != 1 or len(direct_references) != 1:
            continue
        convert = consumers[0]
        convert_name = convert.get("name")
        if not convert_name:
            continue

        for child in graph:
            for input_ in child.findall("input"):
                if input_.get("nodename") == convert_name:
                    input_.set("nodename", target)

        index = list(graph).index(texcoord)
        graph.remove(texcoord)
        graph.remove(convert)
        prefix = f"{target}_generated"
        bounds_min = f"{prefix}_bounds_min"
        bounds_max = f"{prefix}_bounds_max"
        nodes = [
            ET.Element("input", name=bounds_min, type="vector3", value="0, 0, 0"),
            ET.Element("input", name=bounds_max, type="vector3", value="1, 1, 1"),
            ET.Element("position", name=f"{prefix}_position", type="vector3", space="object"),
            ET.Element("subtract", name=f"{prefix}_offset", type="vector3"),
            ET.Element("subtract", name=f"{prefix}_extent", type="vector3"),
            ET.Element("max", name=f"{prefix}_safe_extent", type="vector3"),
            ET.Element("divide", name=target, type="vector3"),
        ]
        ET.SubElement(nodes[3], "input", name="in1", type="vector3", nodename=f"{prefix}_position")
        ET.SubElement(nodes[3], "input", name="in2", type="vector3", interfacename=bounds_min)
        ET.SubElement(nodes[4], "input", name="in1", type="vector3", interfacename=bounds_max)
        ET.SubElement(nodes[4], "input", name="in2", type="vector3", interfacename=bounds_min)
        ET.SubElement(nodes[5], "input", name="in1", type="vector3", nodename=f"{prefix}_extent")
        ET.SubElement(nodes[5], "input", name="in2", type="vector3", value="0.000001, 0.000001, 0.000001")
        ET.SubElement(nodes[6], "input", name="in1", type="vector3", nodename=f"{prefix}_offset")
        ET.SubElement(nodes[6], "input", name="in2", type="vector3", nodename=f"{prefix}_safe_extent")
        for offset, node in enumerate(nodes):
            graph.insert(index + offset, node)
        recovered += 1
    return recovered


def recover_named_geometry_properties(
    graph: ET.Element,
    material: bpy.types.Material,
    contract: dict,
) -> set[str]:
    """Restore explicitly contracted Blender Attribute links as geompropvalue.

    Blender's USD exporter replaces a linked Attribute socket with its default
    value. Recovery is allowed only when an external geometry contract names
    the exact source/target sockets and records the source and GPU binding
    domains. This keeps extraction generic while preventing an inferred domain
    or interpolation rule from silently becoming a production shader contract.
    """
    recovered = set()
    if contract.get("material") != material.name:
        raise RuntimeError(
            f"Geometry contract material {contract.get('material')!r} does not match {material.name!r}"
        )
    for property_ in contract.get("properties", []):
        attribute = material.node_tree.nodes.get(property_.get("attributeNode", ""))
        target_node = material.node_tree.nodes.get(property_.get("targetNode", ""))
        if attribute is None or attribute.bl_idname != "ShaderNodeAttribute":
            raise RuntimeError(f"Geometry contract attribute node is unavailable: {property_}")
        if attribute.attribute_name != property_.get("name"):
            raise RuntimeError(f"Geometry contract attribute name does not match Blender: {property_}")
        if target_node is None:
            raise RuntimeError(f"Geometry contract target node is unavailable: {property_}")
        matching_links = [
            link for link in material.node_tree.links
            if link.from_node == attribute
            and property_.get("outputSocket") in (link.from_socket.name, link.from_socket.identifier)
            and link.to_node == target_node
            and property_.get("targetSocket") in (link.to_socket.name, link.to_socket.identifier)
        ]
        if len(matching_links) != 1:
            raise RuntimeError(f"Geometry contract does not match exactly one Blender link: {property_}")
        link = matching_links[0]
        if target_node.bl_idname != "ShaderNodeMath":
            raise RuntimeError(f"Unsupported contracted target node type: {target_node.bl_idname}")
        socket_index = list(target_node.inputs).index(link.to_socket)
        if socket_index not in (0, 1):
            raise RuntimeError(f"Unsupported Math input index for geometry property: {socket_index}")
        target_name = sanitize(f"bnode__{target_node.name}")
        target = next((child for child in graph if child.get("name") == target_name), None)
        if target is None:
            raise RuntimeError(f"Native MaterialX target node is unavailable: {target_name}")
        input_name = f"in{socket_index + 1}"
        target_input = next((child for child in target.findall("input") if child.get("name") == input_name), None)
        if target_input is None:
            raise RuntimeError(f"Native MaterialX target input is unavailable: {target_name}.{input_name}")

        property_type = property_.get("type")
        if property_type not in ("float", "color3", "vector3"):
            raise RuntimeError(f"Unsupported geometry property type: {property_type}")
        geomprop_name = sanitize(f"bnode__{attribute.name}_{property_.get('name')}")
        geomprop = ET.Element("geompropvalue", name=geomprop_name, type=property_type)
        ET.SubElement(geomprop, "input", name="geomprop", type="string", value=property_.get("name"))
        default = target_input.get("value")
        if default is not None:
            ET.SubElement(geomprop, "input", name="default", type=property_type, value=default)
        graph.insert(list(graph).index(target), geomprop)
        target_input.attrib.pop("value", None)
        target_input.set("nodename", geomprop_name)
        recovered.add(property_.get("name"))
    return recovered


def add_standard_surface(root: ET.Element, graph: ET.Element, surface_prim, material_name: str) -> None:
    surface = ET.SubElement(root, "standard_surface", name="SS_blender_native", type="surfaceshader")
    output_names = set()
    for source_name, target_name in OPEN_PBR_TO_STANDARD_SURFACE.items():
        attribute = surface_prim.GetAttribute(f"inputs:{source_name}")
        if not attribute:
            continue
        connection = source_connection(attribute)
        value = attribute.Get()
        input_type = usd_type(attribute)
        target_type = STANDARD_SURFACE_INPUT_TYPES.get(target_name, input_type)
        if not connection and value is None:
            continue
        child = ET.SubElement(surface, "input", name=target_name, type=target_type)
        if connection:
            if target_type != input_type:
                raise RuntimeError(
                    f"Connected OpenPBR input {source_name} needs unsupported {input_type} -> {target_type} conversion"
                )
            output_name = sanitize(f"{target_name}_out")
            if output_name not in output_names:
                output_names.add(output_name)
                output = ET.SubElement(graph, "output", name=output_name, type=input_type, nodename=sanitize(connection[0]))
                if connection[1] != "out":
                    output.set("output", connection[1])
            child.set("nodegraph", graph.get("name"))
            child.set("output", output_name)
        elif value is not None:
            formatted = format_value(value)
            if target_type == "color3" and input_type == "float":
                formatted = ", ".join([formatted] * 3)
            child.set("value", formatted)
    material = ET.SubElement(root, "surfacematerial", name=sanitize(material_name), type="material")
    ET.SubElement(material, "input", name="surfaceshader", type="surfaceshader", nodename=surface.get("name"))


def convert(
    native_usd: Path,
    material: bpy.types.Material,
    output: Path,
    geometry_contract: dict,
) -> tuple[bool, str, dict[str, str], int, set[str]]:
    stage = Usd.Stage.Open(str(native_usd))
    mtl_prim = material_prim(stage, material.name)
    graph_prim = next((child for child in mtl_prim.GetChildren() if child.GetTypeName() == "NodeGraph"), None)
    surface_prim = next((child for child in mtl_prim.GetChildren() if shader_id(child).startswith("ND_open_pbr_surface")), None)
    if not graph_prim or not surface_prim:
        raise RuntimeError("Native USD material lacks its MaterialX NodeGraph or OpenPBR surface")

    root = ET.Element("materialx", version="1.39", colorspace="lin_rec709")
    graph, categories = add_nodegraph(root, graph_prim)
    recovered_generated = recover_generated_coordinates(graph, categories)
    recovered_properties = recover_named_geometry_properties(graph, material, geometry_contract)
    add_standard_surface(root, graph, surface_prim, material.name)
    ET.indent(root, space="  ")
    output.parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(root).write(output, encoding="utf-8", xml_declaration=True)

    document = mx.createDocument()
    mx.readFromXmlFile(document, str(output))
    valid, message = document.validate()
    return valid, message, categories, recovered_generated, recovered_properties


def main() -> None:
    args = parse_args()
    output = Path(args.output).resolve()
    report_path = Path(args.report).resolve()
    source = Path(bpy.data.filepath).resolve()
    material = bpy.data.materials.get(args.material)
    if material is None or not material.use_nodes:
        raise RuntimeError(f"Node material {args.material!r} not found in {source}")
    clean_previous_dependencies(report_path, output)
    geometry_contract = (
        json.loads(Path(args.geometry_contract).resolve().read_text(encoding="utf-8"))
        if args.geometry_contract
        else {"material": material.name, "properties": []}
    )

    temporary_directory = None
    if args.keep_native_usd:
        native_path = output.with_suffix(".native.usda")
    else:
        temporary_directory = tempfile.TemporaryDirectory()
        native_path = Path(temporary_directory.name) / "materialx-native.usda"
    try:
        export_native_usd(material, native_path)
        textures = copy_texture_dependencies(native_path, output, material.name)
        valid, validation_message, categories, recovered_generated, recovered_properties = convert(
            native_path, material, output, geometry_contract
        )
    finally:
        if temporary_directory is not None:
            temporary_directory.cleanup()

    source_node_types = sorted({node.bl_idname for node in material.node_tree.nodes})
    substituted_semantics = []
    generated_uses = []
    named_geometry_properties = []
    for node in material.node_tree.nodes:
        if node.bl_idname == "ShaderNodeTexCoord":
            generated = node.outputs.get("Generated")
            if generated and generated.is_linked:
                generated_uses.append({"node": node.name, "type": "vector3", "space": "object-bounds-normalized"})
                if recovered_generated <= 0:
                    substituted_semantics.append({
                        "kind": "generated-coordinate",
                        "node": node.name,
                        "reason": "Native Generated-coordinate recovery did not match Blender's USD texcoord surrogate",
                    })
                else:
                    recovered_generated -= 1
        if node.bl_idname == "ShaderNodeAttribute" and node.attribute_name:
            linked_types = {
                link.to_socket.type
                for socket in node.outputs
                for link in socket.links
            }
            materialx_type = "float" if "VALUE" in linked_types else "color3" if "RGBA" in linked_types else "vector3"
            property_contract = next(
                (item for item in geometry_contract.get("properties", []) if item.get("name") == node.attribute_name),
                None,
            )
            named_geometry_properties.append({
                "node": node.name,
                "name": node.attribute_name,
                "type": materialx_type,
                "domain": property_contract.get("sourceDomain") if property_contract else "unknown",
                "bindingDomain": property_contract.get("bindingDomain") if property_contract else "unknown",
                "interpolation": property_contract.get("interpolation") if property_contract else "unknown",
            })
            if node.attribute_name not in recovered_properties:
                substituted_semantics.append({
                    "kind": "named-geometry-property",
                    "node": node.name,
                    "name": node.attribute_name,
                    "type": materialx_type,
                    "reason": "No exact source-domain geometry contract was available for native recovery",
                })
    report = {
        "sourceBlend": source.name,
        "sourceMaterial": material.name,
        "blenderVersion": bpy.app.version_string,
        "extractor": "Blender native USD MaterialX network -> standalone Standard Surface MaterialX",
        "sourceNodeTypes": source_node_types,
        "nativeMaterialXCategories": categories,
        "materialXVersion": "1.39",
        "validation": {"valid": valid, "message": validation_message},
        "textures": textures,
        "geometryContract": os.path.relpath(Path(args.geometry_contract).resolve(), Path.cwd()) if args.geometry_contract else None,
        "capability": {
            "generatedCoordinates": generated_uses,
            "namedGeometryProperties": named_geometry_properties,
            "substitutedSemantics": substituted_semantics,
            "parityReady": not substituted_semantics,
        },
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if not valid:
        raise RuntimeError(f"MaterialX validation failed: {validation_message}")
    print(f"MATERIALX_EXTRACTED {output}")
    print(f"MATERIALX_REPORT {report_path}")


if __name__ == "__main__":
    main()
