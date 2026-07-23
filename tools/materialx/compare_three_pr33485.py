"""Compare released Three r185 and upstream PR #33485 against matched Blender renders."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare_references import metrics, pixels


def sphere_metrics(reference: Path, candidate: Path):
    """Metrics inside a resolution-independent circular sphere region."""
    width_a, height_a, a = pixels(reference)
    width_b, height_b, b = pixels(candidate)
    if (width_a, height_a) != (width_b, height_b):
        raise RuntimeError(f"Image dimensions differ: {reference} vs {candidate}")

    selected_a = []
    selected_b = []
    radius = 0.212
    for y in range(height_a):
        normalized_y = (y + 0.5) / height_a - 0.5
        for x in range(width_a):
            normalized_x = (x + 0.5) / width_a - 0.5
            if normalized_x * normalized_x + normalized_y * normalized_y <= radius * radius:
                index = y * width_a + x
                selected_a.append(a[index])
                selected_b.append(b[index])

    count = len(selected_a)
    luminance_a = [0.2126 * r + 0.7152 * g + 0.0722 * bl for r, g, bl in selected_a]
    luminance_b = [0.2126 * r + 0.7152 * g + 0.0722 * bl for r, g, bl in selected_b]
    mae = sum(abs(x - y) for pa, pb in zip(selected_a, selected_b) for x, y in zip(pa, pb)) / (count * 3)
    rmse = math.sqrt(sum((x - y) ** 2 for pa, pb in zip(selected_a, selected_b) for x, y in zip(pa, pb)) / (count * 3))
    mean_a = sum(luminance_a) / count
    mean_b = sum(luminance_b) / count
    numerator = sum((x - mean_a) * (y - mean_b) for x, y in zip(luminance_a, luminance_b))
    denominator = math.sqrt(sum((x - mean_a) ** 2 for x in luminance_a) * sum((y - mean_b) ** 2 for y in luminance_b))
    return {
        "normalizedCircleRadius": radius,
        "sampleCount": count,
        "rgbMeanAbsoluteError": round(mae, 6),
        "rgbRootMeanSquareError": round(rmse, 6),
        "luminanceCorrelation": round(numerator / denominator if denominator else 0, 6),
        "meanLuminance": {"reference": round(mean_a, 6), "candidate": round(mean_b, 6)},
    }


def main():
    arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    directory = Path(arguments[0] if arguments else "docs/materialx-evidence/archive").resolve()
    reference_directory = Path(arguments[1] if len(arguments) > 1 else "docs/materialx-evidence/current").resolve()
    variants = {
        "sourceLowering": ("chrome-source-blender.png", "chrome-source-web.png"),
        "noiseBumpProbe": ("noise-bump-blender.png", "noise-bump-web.png"),
    }
    implementations = {}
    implementation_directories = {
        "r185LocalAdapter": "r185",
        "pr33485Native": "pr33485",
        "pr33485LocalAdapter": "pr33485-adapter",
    }
    for implementation, implementation_directory in implementation_directories.items():
        implementations[implementation] = {
            name: {
                "fullFrame": metrics(reference_directory / blender, directory / implementation_directory / web),
                "sphereRegion": sphere_metrics(reference_directory / blender, directory / implementation_directory / web),
            }
            for name, (blender, web) in variants.items()
        }

    implementation_delta = {
        comparison: {
            name: {
                "fullFrame": metrics(directory / left / web, directory / right / web),
                "sphereRegion": sphere_metrics(directory / left / web, directory / right / web),
            }
            for name, (_, web) in variants.items()
        }
        for comparison, (left, right) in {
            "r185AdapterToPrNative": ("r185", "pr33485"),
            "r185AdapterToPrAdapter": ("r185", "pr33485-adapter"),
            "prNativeToPrAdapter": ("pr33485", "pr33485-adapter"),
        }.items()
    }

    output = {
        "comparisonVersion": 1,
        "upstream": {
            "pullRequest": "https://github.com/mrdoob/three.js/pull/33485",
            "commit": json.loads((directory / "pr33485/provenance.json").read_text())["commit"],
            "statusAtEvaluation": "open; targeted at Three r186",
        },
        "renderContract": {
            "geometry": "shared 64 x 32 UV sphere and 96-segment floor disc",
            "camera": "50 degree vertical FOV; position [3.2, 2.2, 3.4]; target [0, 0, 0]",
            "lighting": "shared studio-environment.exr at 0.18 plus matched directional lights",
            "colorTransform": "Standard/sRGB, no tone mapping",
            "webBackend": "WebGPURenderer forced to WebGL2",
        },
        "implementations": implementations,
        "implementationDelta": implementation_delta,
        "interpretation": "PR #33485 is evaluated both with its native heighttonormal implementation and with the local derivative adapter. Sphere-region metrics use a resolution-independent normalized mask so the shared background cannot dominate the result. Pixel metrics still include renderer/BRDF differences and do not prove graph-semantic parity.",
    }
    (directory / "upstream-comparison.json").write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
