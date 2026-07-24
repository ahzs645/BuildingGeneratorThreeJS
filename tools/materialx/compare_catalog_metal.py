"""Measure a matched Blender/catalog-MaterialX asset capture."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy


def pixels(path: Path):
    image = bpy.data.images.load(str(path), check_existing=False)
    width, height = image.size
    values = list(image.pixels[:])
    bpy.data.images.remove(image)
    rgb = [
        (values[index], values[index + 1], values[index + 2])
        for index in range(0, len(values), 4)
    ]
    return width, height, rgb


def full_frame_metrics(reference: Path, candidate: Path):
    width_a, height_a, a = pixels(reference)
    width_b, height_b, b = pixels(candidate)
    if (width_a, height_a) != (width_b, height_b):
        raise RuntimeError("Catalog-metal comparison dimensions differ")
    count = len(a)
    luminance_a = [0.2126 * r + 0.7152 * g + 0.0722 * blue for r, g, blue in a]
    luminance_b = [0.2126 * r + 0.7152 * g + 0.0722 * blue for r, g, blue in b]
    mean_a = sum(luminance_a) / count
    mean_b = sum(luminance_b) / count
    numerator = sum(
        (left - mean_a) * (right - mean_b)
        for left, right in zip(luminance_a, luminance_b)
    )
    denominator = math.sqrt(
        sum((value - mean_a) ** 2 for value in luminance_a)
        * sum((value - mean_b) ** 2 for value in luminance_b)
    )
    return {
        "width": width_a,
        "height": height_a,
        "rgbMeanAbsoluteError": round(
            sum(
                abs(left - right)
                for pa, pb in zip(a, b)
                for left, right in zip(pa, pb)
            )
            / (count * 3),
            6,
        ),
        "rgbRootMeanSquareError": round(
            math.sqrt(
                sum(
                    (left - right) ** 2
                    for pa, pb in zip(a, b)
                    for left, right in zip(pa, pb)
                )
                / (count * 3)
            ),
            6,
        ),
        "luminanceCorrelation": round(
            numerator / denominator if denominator else 0,
            6,
        ),
        "meanLuminance": {
            "blender": round(mean_a, 6),
            "web": round(mean_b, 6),
        },
    }


def foreground_metrics(reference: Path, candidate: Path):
    width_a, height_a, a = pixels(reference)
    width_b, height_b, b = pixels(candidate)
    if (width_a, height_a) != (width_b, height_b):
        raise RuntimeError("Catalog-metal comparison dimensions differ")
    background_a = a[0]
    background_b = b[0]

    def distance(color, background):
        return math.sqrt(
            sum((channel - base) ** 2 for channel, base in zip(color, background))
        )

    mask_a = [distance(color, background_a) > 0.02 for color in a]
    mask_b = [distance(color, background_b) > 0.02 for color in b]
    intersection = [left and right for left, right in zip(mask_a, mask_b)]
    union = [left or right for left, right in zip(mask_a, mask_b)]
    selected_a = [color for color, selected in zip(a, intersection) if selected]
    selected_b = [color for color, selected in zip(b, intersection) if selected]
    count = len(selected_a)
    luminance_a = [
        0.2126 * r + 0.7152 * g + 0.0722 * blue for r, g, blue in selected_a
    ]
    luminance_b = [
        0.2126 * r + 0.7152 * g + 0.0722 * blue for r, g, blue in selected_b
    ]
    mean_a = sum(luminance_a) / count
    mean_b = sum(luminance_b) / count
    numerator = sum(
        (left - mean_a) * (right - mean_b)
        for left, right in zip(luminance_a, luminance_b)
    )
    denominator = math.sqrt(
        sum((value - mean_a) ** 2 for value in luminance_a)
        * sum((value - mean_b) ** 2 for value in luminance_b)
    )
    return {
        "maskThresholdRgbDistance": 0.02,
        "blenderPixelCount": sum(mask_a),
        "webPixelCount": sum(mask_b),
        "intersectionPixelCount": sum(intersection),
        "unionPixelCount": sum(union),
        "visibleRegionIntersectionOverUnion": round(
            sum(intersection) / sum(union), 6
        ),
        "intersectionRgbMeanAbsoluteError": round(
            sum(
                abs(left - right)
                for pa, pb in zip(selected_a, selected_b)
                for left, right in zip(pa, pb)
            )
            / (count * 3),
            6,
        ),
        "intersectionRgbRootMeanSquareError": round(
            math.sqrt(
                sum(
                    (left - right) ** 2
                    for pa, pb in zip(selected_a, selected_b)
                    for left, right in zip(pa, pb)
                )
                / (count * 3)
            ),
            6,
        ),
        "intersectionLuminanceCorrelation": round(
            numerator / denominator if denominator else 0,
            6,
        ),
        "intersectionMeanLuminance": {
            "blender": round(mean_a, 6),
            "web": round(mean_b, 6),
        },
    }


CASES = {
    "geometry-nodes-001": {
        "label": "3D Chrome Grill Crayon",
        "object": "3D CHROME CRAYON.001",
        "material": "chrome",
        "geometry": {"vertices": 61_812, "faces": 53_892},
        "blender": "public/dojo/references/chrome-assets/geometry-nodes-001-authored.png",
        "web": "docs/materialx-evidence/current/catalog-metal-chrome-grill-web.png",
        "output": "docs/materialx-evidence/current/catalog-metal-chrome-grill-comparison.json",
    },
    "chain-and-mace": {
        "label": "Chain and Mace",
        "object": "CHAIN N MACE",
        "material": "chrome.002",
        "geometry": {"vertices": 120_727, "faces": 214_718},
        "blender": "public/dojo/references/chrome-assets/chain-and-mace-shader.png",
        "web": "docs/materialx-evidence/current/catalog-metal-chain-and-mace-web.png",
        "output": "docs/materialx-evidence/current/catalog-metal-chain-and-mace-comparison.json",
    },
    "text-soup": {
        "label": "Text Soup",
        "object": "TEXT SOUP",
        "material": "chrome.002",
        "geometry": {"vertices": 11_971, "faces": 11_199},
        "blender": "public/dojo/references/chrome-assets/text-soup-authored.png",
        "web": "docs/materialx-evidence/current/catalog-metal-text-soup-web.png",
        "output": "docs/materialx-evidence/current/catalog-metal-text-soup-comparison.json",
    },
}


def compare(root: Path, asset_id: str, case: dict) -> dict:
    blender = root / case["blender"]
    web = root / case["web"]
    output = {
        "comparisonVersion": 1,
        "asset": asset_id,
        "label": case["label"],
        "sourceObject": case["object"],
        "sourceMaterial": case["material"],
        "geometry": {
            "blender": case["geometry"],
            "web": case["geometry"],
        },
        "renderContract": {
            "resolution": [768, 768],
            "camera": "matched orthographic bounds frame; direction (1,-1.25,0.85), Z up",
            "blenderBackend": "Blender 5.1.2 Eevee with the authored Principled material and bundled CC0 studio.exr",
            "webBackend": "WebGL2 with official MaterialX 1.39.4 standard_surface ESSL/PREFILTER",
            "environment": "Blender 5.1 CC0 studio.exr; exact MaterialX basis transform and official 1024-sample GGX mip chain",
            "colorTransform": "Standard/sRGB, no MaterialX tone mapping",
        },
        "fullFrame": full_frame_metrics(blender, web),
        "foreground": foreground_metrics(blender, web),
        "claim": "Live geometry and extracted constant material inputs are bound through the catalog MaterialX path. Remaining pixels compare Eevee against MaterialX and do not assert renderer identity.",
    }
    path = root / case["output"]
    path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    return output


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    asset_id = args[0] if args else "all"
    root = Path(args[1] if len(args) > 1 else ".").resolve()
    selected = CASES if asset_id == "all" else {
        asset_id: CASES.get(asset_id)
    }
    if None in selected.values():
        raise RuntimeError(f"Unsupported catalog-metal comparison: {asset_id}")
    outputs = [
        compare(root, selected_asset_id, case)
        for selected_asset_id, case in selected.items()
    ]
    print(json.dumps(outputs if asset_id == "all" else outputs[0], indent=2))


if __name__ == "__main__":
    main()
