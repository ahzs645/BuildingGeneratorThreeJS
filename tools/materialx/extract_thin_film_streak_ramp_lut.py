"""Extract Gold's rights-safe thin-film B-spline ramp as a scalar LUT.

Run with Blender after opening Metallic_BSDF+.blend:

  blender --background SOURCE.blend --python this_script.py -- OUTPUT_DIR

Only sampled scalar response values and factual ramp settings are written.
The source .blend and its complete node graph are never copied.
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

import bpy


GROUP_NAME = "Gold"
RAMP_NODE_NAME = "Color Ramp.018"
SAMPLE_COUNT = 256
PNG_NAME = "gold-thin-film-streak-ramp-lut.png"
REPORT_NAME = "gold-thin-film-streak-ramp-lut.json"


def arguments() -> Path:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(argv) != 1:
        raise SystemExit("Expected one OUTPUT_DIR argument after --")
    return Path(argv[0]).resolve()


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return (
        struct.pack(">I", len(payload))
        + body
        + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    )


def encode_grayscale_rgba(values: list[float]) -> bytes:
    scanline = bytearray([0])
    for value in values:
        channel = round(max(0.0, min(1.0, value)) * 255.0)
        scanline.extend((channel, channel, channel, 255))
    header = struct.pack(">IIBBBBB", len(values), 1, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(bytes(scanline), level=9))
        + png_chunk(b"IEND", b"")
    )


def main() -> None:
    output = arguments()
    output.mkdir(parents=True, exist_ok=True)
    group = bpy.data.node_groups.get(GROUP_NAME)
    if group is None:
        raise RuntimeError(f"Missing node group {GROUP_NAME!r}")
    ramp_node = group.nodes.get(RAMP_NODE_NAME)
    if ramp_node is None or ramp_node.bl_idname != "ShaderNodeValToRGB":
        raise RuntimeError(f"Missing Color Ramp node {RAMP_NODE_NAME!r}")
    ramp = ramp_node.color_ramp
    samples = []
    response = []
    for index in range(SAMPLE_COUNT):
        factor = index / (SAMPLE_COUNT - 1)
        value = float(ramp.evaluate(factor)[0])
        response.append(value)
        samples.append({"factor": factor, "response": value})

    png = encode_grayscale_rgba(response)
    png_path = output / PNG_NAME
    png_path.write_bytes(png)
    report = {
        "schemaVersion": 1,
        "kind": "rights-safe-blender-scalar-response-lut",
        "source": {
            "blend": Path(bpy.data.filepath).name,
            "group": GROUP_NAME,
            "rampNode": RAMP_NODE_NAME,
            "redistribution": (
                "Only independently sampled scalar response values are included; "
                "the source .blend and complete node graph are not redistributed."
            ),
        },
        "ramp": {
            "interpolation": ramp.interpolation,
            "colorMode": ramp.color_mode,
            "hueInterpolation": ramp.hue_interpolation,
            "elements": [
                {
                    "position": element.position,
                    "color": list(element.color),
                }
                for element in ramp.elements
            ],
        },
        "sampling": {
            "count": SAMPLE_COUNT,
            "domain": [0.0, 1.0],
            "encoding": "RGBA8 raw grayscale; linear filtering; clamped addressing",
            "coordinate": "u = clamp(factor, 0, 1) * (count - 1) / count + 0.5 / count",
            "png": PNG_NAME,
            "sha256": hashlib.sha256(png).hexdigest(),
            "bytes": len(png),
        },
        "samples": samples,
    }
    report_path = output / REPORT_NAME
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"THIN_FILM_STREAK_RAMP_LUT {png_path}")
    print(f"THIN_FILM_STREAK_RAMP_REPORT {report_path}")


if __name__ == "__main__":
    main()
