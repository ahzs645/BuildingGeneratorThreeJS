import type { Dump } from "../gnvm";

export type BlendStudioSceneUnits = {
  system: string;
  lengthUnit: string;
  scaleLength: number;
  millimetersPerBlenderUnit: number;
};

export function sceneUnits(dump: Dump): BlendStudioSceneUnits {
  const settings = dump.scene?.unit_settings;
  const scaleLength = Number(settings?.scale_length ?? 1);
  const boundedScale = Number.isFinite(scaleLength) && scaleLength > 0
    ? scaleLength
    : 1;
  return {
    system: String(settings?.system ?? "NONE"),
    lengthUnit: String(settings?.length_unit ?? "ADAPTIVE"),
    scaleLength: boundedScale,
    millimetersPerBlenderUnit: boundedScale * 1_000,
  };
}

export function blenderUnitsToMillimeters(dump: Dump, value: number): number {
  return value * sceneUnits(dump).millimetersPerBlenderUnit;
}

export function millimetersToBlenderUnits(dump: Dump, value: number): number {
  return value / sceneUnits(dump).millimetersPerBlenderUnit;
}
