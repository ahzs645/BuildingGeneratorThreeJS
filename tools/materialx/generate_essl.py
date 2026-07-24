"""Generate reproducible MaterialX ESSL shaders and a public interface manifest.

This authoring-time tool uses the Apache-2.0 MaterialX Python modules bundled
with Blender. The generated shader text retains every notice emitted by
MaterialX. No MaterialX runtime or Blender code is shipped with the web app.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import MaterialX as mx
# Blender's MaterialX package requires this import order on macOS.
import MaterialX.PyMaterialXGenShader as mx_gen_shader
import MaterialX.PyMaterialXGenGlsl as mx_gen_glsl


EXPECTED_MATERIALX_VERSION = "1.39.4"
LIGHT_NODEDEF = "ND_directional_light"
LIGHT_TYPE_ID = 1
MAX_LIGHTS = 3


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--environment-mode",
        choices=("fis", "prefilter"),
        default="fis",
        help="MaterialX specular environment implementation used by generated material shaders.",
    )
    parser.add_argument(
        "--write-environment-prefilter",
        action="store_true",
        help="Generate the official MaterialX environment-prefilter pass instead of a material pass.",
    )
    parser.add_argument(
        "--bundle-textures",
        action="store_true",
        help=(
            "Copy authored image inputs into the generated bundle and emit the "
            "verified schema-v2 texture contract required by the browser runtime."
        ),
    )
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    return parser.parse_args(argv)


def value_data(value):
    if value is None:
        return None
    data = value.getData()
    if isinstance(data, (bool, int, float, str)):
        return data
    try:
        return list(data)
    except TypeError:
        return str(data)


def ports(block) -> list[dict]:
    result = []
    for index in range(block.size()):
        port = block[index]
        result.append(
            {
                "name": port.getVariable(),
                "type": port.getType().getName(),
                "value": value_data(port.getValue()),
                "path": port.getPath(),
            }
        )
    return result


def stage_interface(stage, rename_geomprops=False) -> dict:
    input_blocks = {
        name: ports(block)
        for name, block in sorted(stage.getInputBlocks().items())
        if not block.empty()
    }
    if rename_geomprops:
        for block in input_blocks.values():
            for port in block:
                if port["name"].startswith("i_geomprop_"):
                    port["name"] = f"a_geomprop_{port['name'][len('i_geomprop_') :]}"
    return {
        "inputs": input_blocks,
        "uniforms": {
            name: ports(block)
            for name, block in sorted(stage.getUniformBlocks().items())
            if not block.empty()
        },
    }


def canonical_source(source: str) -> str:
    """Keep generated notices/code intact while making Git whitespace-stable."""
    lines = source.splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(line.rstrip() for line in lines) + "\n"


def rewrite_geomprop_vertex_inputs(source: str) -> str:
    """Avoid MaterialX ESSL's input/varying name collision for geomprops."""
    names = re.findall(r"^in\s+[^;]+\s+(i_geomprop_[A-Za-z0-9_]+);$", source, re.MULTILINE)
    for name in names:
        attribute = f"a_geomprop_{name[len('i_geomprop_') :]}"
        source = re.sub(
            rf"^(in\s+[^;]+\s+){re.escape(name)};$",
            rf"\1{attribute};",
            source,
            count=1,
            flags=re.MULTILINE,
        )
        source = source.replace(f"{name} = {name};", f"{name} = {attribute};")
    return source


def rewrite_environment_prefilter_essl(source: str) -> str:
    """Repair MaterialX 1.39.4's WebGL-invalid float/int pow overload."""
    needle = "pow(2.0, u_envPrefilterMip)"
    if source.count(needle) != 1:
        raise RuntimeError(
            "Expected exactly one MaterialX environment-prefilter mip exponent expression"
        )
    return source.replace(needle, "exp2(float(u_envPrefilterMip))")


def geomprop_definitions(source: Path) -> dict[str, dict]:
    definitions = {}
    for node in ET.parse(source).getroot().iter("geompropvalue"):
        inputs = {child.get("name"): child for child in node.findall("input")}
        geomprop = inputs.get("geomprop")
        if geomprop is None or not geomprop.get("value"):
            continue
        default = inputs.get("default")
        name = geomprop.get("value")
        definition = {
            "name": name,
            "type": node.get("type"),
            "required": True,
        }
        if default is not None:
            definition["default"] = default.get("value")
        existing = definitions.get(name)
        if existing is not None and existing["type"] != definition["type"]:
            raise RuntimeError(f"Geometry property {name!r} is used with conflicting types")
        definitions[name] = definition
    return definitions


MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".avif": "image/avif",
}
ADDRESS_MODES = {
    "periodic": "repeat",
    "clamp": "clamp",
    "mirror": "mirror",
}
FILTERS = {
    "closest": ("nearest", "nearest"),
    "linear": ("linear", "linear"),
}
COLOR_SPACES = {"raw", "lin_rec709", "srgb_texture"}


def plain_relative_texture_path(value: str) -> Path:
    if (
        not value
        or value != value.strip()
        or "\\" in value
        or value.startswith("/")
        or value.startswith("//")
        or "?" in value
        or "#" in value
        or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", value)
    ):
        raise RuntimeError(f"Texture path must be a plain relative path: {value!r}")
    path = Path(value)
    if any(part in ("", ".", "..") for part in path.parts):
        raise RuntimeError(f"Texture path may not contain traversal or ambiguous segments: {value!r}")
    return path


def authored_texture_contracts(source: Path) -> dict[str, dict]:
    """Index image files by authored filename value and preserve sampler intent."""
    root = ET.parse(source).getroot()
    contracts = {}
    for image in root.iter("image"):
        inputs = {child.get("name"): child for child in image.findall("input")}
        file_input = inputs.get("file")
        if file_input is None or not file_input.get("value"):
            continue
        value = file_input.get("value")
        relative = plain_relative_texture_path(value)
        path = (source.parent / relative).resolve()
        if not path.is_file():
            raise RuntimeError(f"MaterialX texture does not exist: {path}")
        try:
            path.relative_to(source.parent.resolve())
        except ValueError as error:
            raise RuntimeError(f"MaterialX texture escapes the source directory: {value!r}") from error

        source_color_space = file_input.get("colorspace", "raw")
        if source_color_space not in COLOR_SPACES:
            raise RuntimeError(
                f"Unsupported texture colorspace {source_color_space!r} for {value!r}"
            )
        uaddress = inputs.get("uaddressmode")
        vaddress = inputs.get("vaddressmode")
        filter_input = inputs.get("filtertype")
        authored_uaddress = uaddress.get("value", "periodic") if uaddress is not None else "periodic"
        authored_vaddress = vaddress.get("value", "periodic") if vaddress is not None else "periodic"
        authored_filter = filter_input.get("value", "linear") if filter_input is not None else "linear"
        if authored_uaddress not in ADDRESS_MODES or authored_vaddress not in ADDRESS_MODES:
            raise RuntimeError(
                f"Unsupported texture address mode for {value!r}: "
                f"{authored_uaddress!r}, {authored_vaddress!r}"
            )
        if authored_filter not in FILTERS:
            raise RuntimeError(f"Unsupported texture filter {authored_filter!r} for {value!r}")
        mime_type = MIME_TYPES.get(path.suffix.lower())
        if mime_type is None:
            raise RuntimeError(f"Unsupported browser texture format for {value!r}")
        min_filter, mag_filter = FILTERS[authored_filter]
        contract = {
            "source": path,
            "relative": relative,
            "sourceColorSpace": source_color_space,
            "uploadColorSpace": "none",
            "wrapS": ADDRESS_MODES[authored_uaddress],
            "wrapT": ADDRESS_MODES[authored_vaddress],
            "minFilter": min_filter,
            "magFilter": mag_filter,
            "flipY": False,
            "mimeType": mime_type,
        }
        existing = contracts.get(value)
        if existing is not None and existing != contract:
            raise RuntimeError(f"Conflicting sampler contracts for texture {value!r}")
        contracts[value] = contract
    return contracts


def bundle_texture_bindings(
    output: Path,
    fragment_interface: dict,
    contracts: dict[str, dict],
) -> list[dict]:
    bindings = []
    for block in fragment_interface["uniforms"].values():
        for port in block:
            if port["type"] != "filename" or not port["value"]:
                continue
            contract = contracts.get(port["value"])
            if contract is None:
                raise RuntimeError(
                    f"Generated filename uniform {port['name']!r} has no authored image contract"
                )
            payload = contract["source"].read_bytes()
            bundled_relative = Path("textures") / contract["relative"]
            bundled_path = output / bundled_relative
            bundled_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(contract["source"], bundled_path)
            bindings.append(
                {
                    "uniform": port["name"],
                    "path": bundled_relative.as_posix(),
                    "sourceColorSpace": contract["sourceColorSpace"],
                    "uploadColorSpace": contract["uploadColorSpace"],
                    "wrapS": contract["wrapS"],
                    "wrapT": contract["wrapT"],
                    "minFilter": contract["minFilter"],
                    "magFilter": contract["magFilter"],
                    "flipY": contract["flipY"],
                    "sha256": hashlib.sha256(payload).hexdigest(),
                    "bytes": len(payload),
                    "mimeType": contract["mimeType"],
                }
            )
    return bindings


def geometry_bindings(vertex_interface: dict, fragment_interface: dict, definitions: dict[str, dict]) -> dict:
    properties = []
    for block in vertex_interface["inputs"].values():
        for port in block:
            prefix = "a_geomprop_"
            if not port["name"].startswith(prefix):
                continue
            name = port["name"][len(prefix) :]
            definition = definitions.get(name, {"name": name, "type": port["type"], "required": True})
            properties.append({**definition, "attribute": port["name"]})

    uniforms = [port for block in fragment_interface["uniforms"].values() for port in block]
    # MaterialX flattens internal node names into interface paths when a
    # nodedef is emitted from a nodegraph, while direct graph inputs retain a
    # slash separator. Match the authored semantic suffix in either form.
    minimum = [port["name"] for port in uniforms if port["path"].endswith("generated_bounds_min")]
    maximum = [port["name"] for port in uniforms if port["path"].endswith("generated_bounds_max")]
    result = {}
    if minimum or maximum:
        if not minimum or not maximum:
            raise RuntimeError("Generated-coordinate graph must expose both bounds inputs")
        result["generatedCoordinates"] = {
            "space": "object",
            "boundsMinUniforms": minimum,
            "boundsMaxUniforms": maximum,
        }
    if properties:
        result["properties"] = sorted(properties, key=lambda item: item["name"])
    return result


def main() -> None:
    options = arguments()
    if mx.__version__ != EXPECTED_MATERIALX_VERSION:
        raise RuntimeError(
            f"MaterialX {EXPECTED_MATERIALX_VERSION} required; found {mx.__version__}"
        )

    source = options.input.resolve()
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    libraries = mx.createDocument()
    search_path = mx.getDefaultDataSearchPath()
    mx.loadLibraries(mx.getDefaultDataLibraryFolders(), search_path, libraries)

    document = mx.createDocument()
    mx.readFromXmlFile(document, str(source))
    document.setDataLibrary(libraries)
    valid, validation = document.validate()
    if not valid:
        raise RuntimeError(f"MaterialX validation failed:\n{validation}")

    generator = mx_gen_glsl.EsslShaderGenerator.create()
    generator.registerTypeDefs(document)
    context = mx_gen_shader.GenContext(generator)
    context.registerSourceCodeSearchPath(search_path)
    context.registerSourceCodeSearchPath(str(source.parent))
    generation = context.getOptions()
    generation.shaderInterfaceType = mx_gen_shader.ShaderInterfaceType.SHADER_INTERFACE_COMPLETE
    generation.hwSpecularEnvironmentMethod = (
        mx_gen_shader.SPECULAR_ENVIRONMENT_FIS
        if options.environment_mode == "fis"
        else mx_gen_shader.SPECULAR_ENVIRONMENT_PREFILTER
    )
    generation.hwWriteEnvPrefilter = options.write_environment_prefilter
    generation.hwMaxActiveLightSources = MAX_LIGHTS
    generation.fileTextureVerticalFlip = False
    generation.hwSrgbEncodeOutput = True

    color_management = mx_gen_shader.DefaultColorManagementSystem.create(generator.getTarget())
    color_management.loadLibrary(document)
    generator.setColorManagementSystem(color_management)

    light_nodedef = libraries.getNodeDef(LIGHT_NODEDEF)
    if light_nodedef is None:
        raise RuntimeError(f"Missing MaterialX light NodeDef {LIGHT_NODEDEF}")
    mx_gen_shader.HwShaderGenerator.unbindLightShaders(context)
    mx_gen_shader.HwShaderGenerator.bindLightShader(light_nodedef, LIGHT_TYPE_ID, context)

    manifest = {
        "schemaVersion": 2 if options.bundle_textures else 1,
        "generator": {
            "materialx": mx.__version__,
            "target": generator.getTarget(),
            "specularEnvironment": options.environment_mode.upper(),
            "radianceSamples": 16,
            "maxLights": MAX_LIGHTS,
            "lightNodeDef": LIGHT_NODEDEF,
            "lightTypeId": LIGHT_TYPE_ID,
            "source": source.name,
        },
        "licenses": {
            "materialx": "../licenses/LICENSE",
            "thirdPartyNotices": "../licenses/THIRD-PARTY.md",
        },
        "shaders": {},
    }
    if options.write_environment_prefilter:
        manifest["generator"]["writesEnvironmentPrefilter"] = True
        manifest["generator"]["compatibilityRewrites"] = [
            "pow(2.0, u_envPrefilterMip) -> exp2(float(u_envPrefilterMip))"
        ]
    property_definitions = geomprop_definitions(source)
    texture_contracts = authored_texture_contracts(source) if options.bundle_textures else {}

    renderables = mx_gen_shader.findRenderableElements(document)
    if not renderables:
        raise RuntimeError("MaterialX document has no renderable elements")
    if options.write_environment_prefilter:
        renderables = renderables[:1]
    for element in renderables:
        shader_name = (
            "MaterialXEnvironmentPrefilter"
            if options.write_environment_prefilter
            else mx.createValidName(element.getName())
        )
        shader = generator.generate(shader_name, element, context)
        if shader is None:
            raise RuntimeError(f"Generation failed for {element.getNamePath()}")
        vertex = rewrite_geomprop_vertex_inputs(shader.getSourceCode(mx_gen_shader.VERTEX_STAGE))
        fragment = shader.getSourceCode(mx_gen_shader.PIXEL_STAGE)
        if options.write_environment_prefilter:
            fragment = rewrite_environment_prefilter_essl(fragment)
        vertex_name = f"{shader.getName()}.vert"
        fragment_name = f"{shader.getName()}.frag"
        (output / vertex_name).write_text(canonical_source(vertex), encoding="utf-8")
        (output / fragment_name).write_text(canonical_source(fragment), encoding="utf-8")
        vertex_interface = stage_interface(shader.getStage(mx_gen_shader.VERTEX_STAGE), rename_geomprops=True)
        fragment_interface = stage_interface(shader.getStage(mx_gen_shader.PIXEL_STAGE))
        shader_record = {
            "element": element.getNamePath(),
            "vertex": vertex_name,
            "fragment": fragment_name,
            "vertexInterface": vertex_interface,
            "fragmentInterface": fragment_interface,
            "geometryBindings": geometry_bindings(vertex_interface, fragment_interface, property_definitions),
        }
        if options.bundle_textures:
            shader_record["textureBindings"] = bundle_texture_bindings(
                output,
                fragment_interface,
                texture_contracts,
            )
        manifest["shaders"][shader.getName()] = shader_record

    (output / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"MATERIALX_ESSL_GENERATED {output}")


if __name__ == "__main__":
    main()
