"""Compute renderer evidence from matched 768px Blender/browser PNG pairs."""

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
    rgb = [(values[index], values[index + 1], values[index + 2]) for index in range(0, len(values), 4)]
    return width, height, rgb


def metrics(reference: Path, candidate: Path):
    width_a, height_a, a = pixels(reference)
    width_b, height_b, b = pixels(candidate)
    if (width_a, height_a) != (width_b, height_b):
        raise RuntimeError(f"Image dimensions differ: {reference} vs {candidate}")
    count = len(a)
    luminance_a = [0.2126 * r + 0.7152 * g + 0.0722 * bl for r, g, bl in a]
    luminance_b = [0.2126 * r + 0.7152 * g + 0.0722 * bl for r, g, bl in b]
    mae = sum(abs(x - y) for pa, pb in zip(a, b) for x, y in zip(pa, pb)) / (count * 3)
    rmse = math.sqrt(sum((x - y) ** 2 for pa, pb in zip(a, b) for x, y in zip(pa, pb)) / (count * 3))
    mean_a = sum(luminance_a) / count
    mean_b = sum(luminance_b) / count
    numerator = sum((x - mean_a) * (y - mean_b) for x, y in zip(luminance_a, luminance_b))
    denominator = math.sqrt(sum((x - mean_a) ** 2 for x in luminance_a) * sum((y - mean_b) ** 2 for y in luminance_b))
    correlation = numerator / denominator if denominator else 0
    return {
        "width": width_a,
        "height": height_a,
        "rgbMeanAbsoluteError": round(mae, 6),
        "rgbRootMeanSquareError": round(rmse, 6),
        "luminanceCorrelation": round(correlation, 6),
        "meanLuminance": {"blender": round(mean_a, 6), "web": round(mean_b, 6)},
    }


def sphere_metrics(reference: Path, candidate: Path):
    """Compare the normalized sphere region so background and resolution cannot dominate."""
    width_a, height_a, a = pixels(reference)
    width_b, height_b, b = pixels(candidate)
    if (width_a, height_a) != (width_b, height_b):
        raise RuntimeError(f"Image dimensions differ: {reference} vs {candidate}")
    radius = 0.212
    selected_a = []
    selected_b = []
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
    mean_a = sum(luminance_a) / count
    mean_b = sum(luminance_b) / count
    numerator = sum((x - mean_a) * (y - mean_b) for x, y in zip(luminance_a, luminance_b))
    denominator = math.sqrt(sum((x - mean_a) ** 2 for x in luminance_a) * sum((y - mean_b) ** 2 for y in luminance_b))
    return {
        "normalizedCircleRadius": radius,
        "sampleCount": count,
        "rgbMeanAbsoluteError": round(sum(abs(x - y) for pa, pb in zip(selected_a, selected_b) for x, y in zip(pa, pb)) / (count * 3), 6),
        "rgbRootMeanSquareError": round(math.sqrt(sum((x - y) ** 2 for pa, pb in zip(selected_a, selected_b) for x, y in zip(pa, pb)) / (count * 3)), 6),
        "luminanceCorrelation": round(numerator / denominator if denominator else 0, 6),
        "meanLuminance": {"blender": round(mean_a, 6), "web": round(mean_b, 6)},
    }


def sphere_mean_rgb(reference: Path, candidate: Path):
    """Expose channel means so thin-film hue drift cannot hide behind luminance correlation."""
    width_a, height_a, a = pixels(reference)
    width_b, height_b, b = pixels(candidate)
    if (width_a, height_a) != (width_b, height_b):
        raise RuntimeError(f"Image dimensions differ: {reference} vs {candidate}")
    radius = 0.212
    selected = []
    for source in (a, b):
        sums = [0.0, 0.0, 0.0]
        count = 0
        for y in range(height_a):
            normalized_y = (y + 0.5) / height_a - 0.5
            for x in range(width_a):
                normalized_x = (x + 0.5) / width_a - 0.5
                if normalized_x * normalized_x + normalized_y * normalized_y <= radius * radius:
                    pixel = source[y * width_a + x]
                    for channel in range(3):
                        sums[channel] += pixel[channel]
                    count += 1
        selected.append([round(value / count, 6) for value in sums])
    return {"blender": selected[0], "web": selected[1]}


def main():
    directory = Path(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "docs/materialx-evidence/current").resolve()
    roughness_values = (0.0, 2.0 / 15.0, 0.2610441)

    def roughness_slug(value: float):
        return format(value, ".7g").replace(".", "p")

    output = {
        "comparisonVersion": 15,
        "renderContract": {
            "geometry": "shared outward-wound 64 x 32 UV sphere algorithm and 96-segment floor disc",
            "camera": "scene-contract.json schema 1; Blender evaluated matrix_world and 50 degree vertical FOV",
            "lighting": "shared linear studio EXR at 0.18 strength plus three matched directional lights",
            "environment": "studio-environment.exr; solid camera background, HDR reflections only",
            "exposure": 0,
            "colorTransform": "Standard/sRGB, no tone mapping",
            "webBackend": "WebGLRenderer with offline-generated official MaterialX 1.39.4 ESSL",
            "webEnvironment": "MaterialX FIS at 16 samples per pixel and official 1024-sample GGX PREFILTER mip lookup are compared over the same linear lat-long radiance plus separate third-order SH irradiance EXR",
            "directLights": "scene-contract.json evaluated Sun local -Z propagation vectors; generated directional NodeDef negates LightData.direction to surface-to-light L",
            "directionalDiagnostics": "light-{key,fill,rim}-{blender,web}.png; one light at a time, zero environment strength, zero Sun angular radius",
            "coordinateDiagnostic": "coordinate-cardinals-web.png; columns +X, +Z, -X, -Z; radiance top and direct lights bottom",
            "uiNormalBandDiagnostic": "ui-normal-band-{blender,web}.png; rotated probe with explicit object-to-world Normal, Mapping, CONSTANT ramp, typed col, and unlit surface",
            "metalPresetMatrix": "metal-preset-{aluminum,copper,gold,stainless-steel,titanium}-{blender,web}.png; constant PHYSICAL_CONDUCTOR n/k values, Blender perceptual roughness 0.35 mapped to MaterialX microfacet alpha 0.1225, no direct lights or floor",
            "metalF82Probe": "metal-f82-gold-{blender,web}.png; Blender Metallic BSDF F82 versus MaterialX generalized_schlick_bsdf, exact linear color0/color82 values, roughness 0.35 mapped to alpha 0.1225, no direct lights or floor",
            "metalLayeredRoughnessProbe": "metal-layered-roughness-gold-{blender,web}.png; exact four-closure Gold F82 chain with Blender perceptual roughness scales 0.25/0.5/0.75/1.0, sequential mix factors 0.4/0.2/0.1, no direct lights or floor",
            "metalRoughnessFresnelProbe": "metal-roughness-fresnel-{scalar-,}gold-{blender,web}.png; exact Blender Layer Weight Blend 0.1 dielectric Fresnel, sampled Gold RGB Curve/B-spline ramp response, MULTIPLY Mix field, roughness 0.35, no direct lights or floor",
            "metalBrushedRoughnessProbe": "metal-brushed-roughness-{scalar-,}gold-{blender,web}.png; active Gold controls roughness 0.4499999583, Generated-coordinate scale 100, length mix 0.9549999833, normalized Blender 3D FBM scale 20/detail 2/roughness 0.5/lacunarity 2, brush factor 0.2730000019, no source scratch images, direct lights, or floor",
            "metalThinFilmStreakProbe": "metal-thin-film-streak-{scalar-,}gold-{blender,web}.png; explicit diagnostic override binds the otherwise-unlinked Gold Socket_27 to Generated coordinates, combines normalized scale-20 and raw scale-10 Blender FBM fields into T/1390 scalar and T nm beauty outputs, scalar uses one sample per pixel in both renderers without Eevee temporal averaging, beauty uses roughness 0.45, thin-film IOR 2.46, key light only, no environment or floor; the supplied active Material.011 remains exactly 0 nm",
            "metalAnisotropyProbe": "metal-anisotropy-gold-{r0,r90}-{blender,web}.png; Blender Cycles versus MaterialX, anisotropy 0.8, radial-Y/Tworld tangent, rotations 0 and 0.25 turns, Blender alpha/aspect mapping, key light only, no environment or floor",
            "metalThinFilmProbe": "metal-thin-film-gold-{0,243}nm-{blender,web}.png; Blender Cycles Metallic BSDF F82 versus MaterialX generalized_schlick_bsdf, source Gold-group mapping 150 V x 1.62 nm/V = 243 nm, thin-film IOR 2.46, key light only, no environment or floor",
        },
        "sourceLowering": {
            **metrics(directory / "chrome-source-blender.png", directory / "chrome-source-web.png"),
            "sphereRegion": sphere_metrics(directory / "chrome-source-blender.png", directory / "chrome-source-web.png"),
        },
        "noiseBumpProbe": {
            **metrics(directory / "noise-bump-blender.png", directory / "noise-bump-web.png"),
            "sphereRegion": sphere_metrics(directory / "noise-bump-blender.png", directory / "noise-bump-web.png"),
        },
        "uiNormalBandDiagnostic": {
            **metrics(directory / "ui-normal-band-blender.png", directory / "ui-normal-band-web.png"),
            "sphereRegion": sphere_metrics(directory / "ui-normal-band-blender.png", directory / "ui-normal-band-web.png"),
            "claim": "topology-derived branch-semantic parity on rotated geometry; native USD extraction remains unavailable because the source .blend was not supplied",
        },
        "directionalLightDiagnostics": {
            light: {
                **metrics(directory / f"light-{light}-blender.png", directory / f"light-{light}-web.png"),
                "sphereRegion": sphere_metrics(directory / f"light-{light}-blender.png", directory / f"light-{light}-web.png"),
            }
            for light in ("key", "fill", "rim")
        },
        "roughnessEnvironmentSweep": {
            format(roughness, ".7g"): {
                environment: {
                    **metrics(
                        directory / f"roughness-{roughness_slug(roughness)}-blender.png",
                        directory / f"roughness-{roughness_slug(roughness)}-{environment}-web.png",
                    ),
                    "sphereRegion": sphere_metrics(
                        directory / f"roughness-{roughness_slug(roughness)}-blender.png",
                        directory / f"roughness-{roughness_slug(roughness)}-{environment}-web.png",
                    ),
                }
                for environment in ("fis", "prefilter")
            }
            for roughness in roughness_values
        },
        "metalPresetMatrix": {
            preset: {
                **metrics(
                    directory / f"metal-preset-{preset}-blender.png",
                    directory / f"metal-preset-{preset}-web.png",
                ),
                "sphereRegion": sphere_metrics(
                    directory / f"metal-preset-{preset}-blender.png",
                    directory / f"metal-preset-{preset}-web.png",
                ),
                "claim": "constant-input PHYSICAL_CONDUCTOR semantics only; not the complete Metallic BSDF+ preset graph",
            }
            for preset in (
                "aluminum",
                "copper",
                "gold",
                "stainless-steel",
                "titanium",
            )
        },
        "metalF82Probe": {
            **metrics(
                directory / "metal-f82-gold-blender.png",
                directory / "metal-f82-gold-web.png",
            ),
            "sphereRegion": sphere_metrics(
                directory / "metal-f82-gold-blender.png",
                directory / "metal-f82-gold-web.png",
            ),
            "claim": "constant-input F82 semantics only; not the complete Metallic BSDF+ Gold graph",
        },
        "metalLayeredRoughnessProbe": {
            **metrics(
                directory / "metal-layered-roughness-gold-blender.png",
                directory / "metal-layered-roughness-gold-web.png",
            ),
            "sphereRegion": sphere_metrics(
                directory / "metal-layered-roughness-gold-blender.png",
                directory / "metal-layered-roughness-gold-web.png",
            ),
            "claim": "constant-input layered-roughness closure semantics only; no roughness-Fresnel or texture branch",
        },
        "metalRoughnessFresnelProbe": {
            "scalar": {
                **metrics(
                    directory / "metal-roughness-fresnel-scalar-gold-blender.png",
                    directory / "metal-roughness-fresnel-scalar-gold-web.png",
                ),
                "sphereRegion": sphere_metrics(
                    directory / "metal-roughness-fresnel-scalar-gold-blender.png",
                    directory / "metal-roughness-fresnel-scalar-gold-web.png",
                ),
                "claim": "view-dependent Layer Weight/RGB Curve/B-spline ramp/MULTIPLY roughness field semantics",
            },
            "beauty": {
                **metrics(
                    directory / "metal-roughness-fresnel-gold-blender.png",
                    directory / "metal-roughness-fresnel-gold-web.png",
                ),
                "sphereRegion": sphere_metrics(
                    directory / "metal-roughness-fresnel-gold-blender.png",
                    directory / "metal-roughness-fresnel-gold-web.png",
                ),
                "claim": "Gold F82 with the validated view-dependent roughness field; no scratch, brushed, anisotropy, thin-film streak, or source add-on graph",
            },
        },
        "metalBrushedRoughnessProbe": {
            "scalar": {
                **metrics(
                    directory / "metal-brushed-roughness-scalar-gold-blender.png",
                    directory / "metal-brushed-roughness-scalar-gold-web.png",
                ),
                "sphereRegion": sphere_metrics(
                    directory / "metal-brushed-roughness-scalar-gold-blender.png",
                    directory / "metal-brushed-roughness-scalar-gold-web.png",
                ),
                "claim": "active Gold Generated-coordinate/normalized-3D-FBM/remap/ADD/SCREEN perceptual-roughness field with both source scratch-image branches omitted",
            },
            "beauty": {
                **metrics(
                    directory / "metal-brushed-roughness-gold-blender.png",
                    directory / "metal-brushed-roughness-gold-web.png",
                ),
                "sphereRegion": sphere_metrics(
                    directory / "metal-brushed-roughness-gold-blender.png",
                    directory / "metal-brushed-roughness-gold-web.png",
                ),
                "claim": "Gold F82 with the isolated active procedural brushed-roughness field; no source scratch images, anisotropy, layered closure, or thin film",
            },
            "noiseResidual": "Native MaterialX fractal3d is not value-identical to Blender Noise Texture. These marked shaders therefore use the declared blender-normalized-fbm3 ESSL semantic adapter; remaining high-frequency image error is raster filtering and renderer integration, not a native-fractal3d parity claim.",
        },
        "metalThinFilmStreakProbe": {
            "activeSourceResultNanometers": 0,
            "activeSourceReason": "Gold Socket_27 is unlinked at (0,0,0), so its raw FBM and B-spline ramp are black; anodization voltage is also 0.",
            "diagnosticOverride": "Gold Socket_27 / outer Socket_919 is explicitly rebound to Blender Generated coordinates in both renderers to exercise the otherwise-zero procedural branch.",
            "scalar": {
                **metrics(
                    directory / "metal-thin-film-streak-scalar-gold-blender.png",
                    directory / "metal-thin-film-streak-scalar-gold-web.png",
                ),
                "sphereRegion": sphere_metrics(
                    directory / "metal-thin-film-streak-scalar-gold-blender.png",
                    directory / "metal-thin-film-streak-scalar-gold-web.png",
                ),
                "claim": "activated Gold normalized-FBM/remap times raw-FBM/B-spline streak mask, displayed as T/1390 unlit grayscale with one sample per pixel and no temporal averaging; this is an explicit Generated-coordinate diagnostic override, not the supplied active material result",
            },
            "beauty": {
                **metrics(
                    directory / "metal-thin-film-streak-gold-blender.png",
                    directory / "metal-thin-film-streak-gold-web.png",
                ),
                "sphereRegion": sphere_metrics(
                    directory / "metal-thin-film-streak-gold-blender.png",
                    directory / "metal-thin-film-streak-gold-web.png",
                ),
                "sphereMeanRgb": sphere_mean_rgb(
                    directory / "metal-thin-film-streak-gold-blender.png",
                    directory / "metal-thin-film-streak-gold-web.png",
                ),
                "claim": "Gold F82 at perceptual roughness 0.45 with the activated procedural mask mapped to 0..1390 nm and thin-film IOR 2.46; no roughness Fresnel, brushed roughness, scratches, anisotropy, layered closure, or source add-on graph",
                "residual": "MaterialX and Blender use different spectral thin-film approximations; matching spatial thickness preserves streak placement and lobe structure but not exact interference hue.",
            },
            "semanticAdapters": [
                "blender-normalized-fbm3",
                "blender-raw-fbm3",
            ],
            "noiseResidual": "The explicit adapters preserve Blender's normalized and raw FBM semantics. Remaining high-frequency error includes raster filtering and renderer integration across coordinate frequencies up to 2000 and 900.",
        },
        "metalAnisotropyProbe": {
            rotation: {
                **metrics(
                    directory / f"metal-anisotropy-gold-{rotation}-blender.png",
                    directory / f"metal-anisotropy-gold-{rotation}-web.png",
                ),
                "sphereRegion": sphere_metrics(
                    directory / f"metal-anisotropy-gold-{rotation}-blender.png",
                    directory / f"metal-anisotropy-gold-{rotation}-web.png",
                ),
                "claim": "constant-input anisotropy/tangent semantics only; no brushed texture branch",
            }
            for rotation in ("r0", "r90")
        },
        "metalThinFilmProbe": {
            f"{thickness}nm": {
                **metrics(
                    directory / f"metal-thin-film-gold-{thickness}nm-blender.png",
                    directory / f"metal-thin-film-gold-{thickness}nm-web.png",
                ),
                "sphereRegion": sphere_metrics(
                    directory / f"metal-thin-film-gold-{thickness}nm-blender.png",
                    directory / f"metal-thin-film-gold-{thickness}nm-web.png",
                ),
                "sphereMeanRgb": sphere_mean_rgb(
                    directory / f"metal-thin-film-gold-{thickness}nm-blender.png",
                    directory / f"metal-thin-film-gold-{thickness}nm-web.png",
                ),
                "claim": "constant-input thin-film thickness and IOR semantics only; no procedural streak branch",
                "residual": "MaterialX and Blender use different spectral approximations; matching inputs preserve lobe structure and luminance but not exact interference hue.",
            }
            for thickness in (0, 243)
        },
        "interpretation": "Image metrics include expected Eevee/Three BRDF, shadow, and light-unit differences. Graph-semantic support is reported separately in manifest.json and is not inferred from these pixels.",
    }
    (directory / "comparison.json").write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
