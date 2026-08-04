import { auroraMode, defaultAuroraSettings } from '../geometry-painter/modes/aurora';
import { crystalMode, defaultCrystalSettings } from '../geometry-painter/modes/crystals';
import { defaultFissureSettings, fissureMode } from '../geometry-painter/modes/fissures';
import { defaultReefSettings, reefMode } from '../geometry-painter/modes/reef';
import { surfaceGenerator } from './generator-catalog';
import { createPaintModeAdapter } from './paint-mode-adapter';

export const crystalAdapter = createPaintModeAdapter(
  surfaceGenerator('crystals'),
  crystalMode,
  defaultCrystalSettings,
);

export const moltenAdapter = createPaintModeAdapter(
  surfaceGenerator('molten'),
  fissureMode,
  defaultFissureSettings,
);

export const auroraAdapter = createPaintModeAdapter(
  surfaceGenerator('aurora'),
  auroraMode,
  defaultAuroraSettings,
);

export const reefAdapter = createPaintModeAdapter(
  surfaceGenerator('reef'),
  reefMode,
  defaultReefSettings,
);

export const PROCEDURAL_PAINT_ADAPTERS = [
  crystalAdapter,
  moltenAdapter,
  auroraAdapter,
  reefAdapter,
] as const;

