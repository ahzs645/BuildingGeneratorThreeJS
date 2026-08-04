import type { SurfaceGeneratorId, SurfaceInteractionMode } from './contracts';

export type SurfaceGeneratorFamily = 'vegetation' | 'decor' | 'blender';

export interface SurfaceGeneratorCapabilities {
  readonly input: 'surface-strokes' | 'ground';
  readonly sceneMode: 'overlay' | 'exclusive';
  readonly interactionModes: readonly SurfaceInteractionMode[];
  readonly usesProjectionTarget: boolean;
  readonly usesDrawingArea: boolean;
  readonly supportsUndoClear: boolean;
}

export interface SurfaceGeneratorDescriptor {
  readonly id: SurfaceGeneratorId;
  readonly label: string;
  readonly shortLabel: string;
  readonly code: string;
  readonly family: SurfaceGeneratorFamily;
  readonly description: string;
  readonly capabilities: SurfaceGeneratorCapabilities;
}

const SURFACE_BRUSH_MODES: readonly SurfaceInteractionMode[] = [
  'orbit',
  'pick-target',
  'place-area',
  'draw',
  'select',
];

const SURFACE_BRUSH_CAPABILITIES: SurfaceGeneratorCapabilities = {
  input: 'surface-strokes',
  sceneMode: 'overlay',
  interactionModes: SURFACE_BRUSH_MODES,
  usesProjectionTarget: true,
  usesDrawingArea: true,
  supportsUndoClear: true,
};

const IVY_CAPABILITIES: SurfaceGeneratorCapabilities = {
  ...SURFACE_BRUSH_CAPABILITIES,
  interactionModes: [...SURFACE_BRUSH_MODES, 'flower'],
};

const TREE_CAPABILITIES: SurfaceGeneratorCapabilities = {
  input: 'ground',
  sceneMode: 'exclusive',
  interactionModes: ['orbit', 'interact', 'flower'],
  usesProjectionTarget: false,
  usesDrawingArea: false,
  supportsUndoClear: false,
};

export const SURFACE_GENERATORS: readonly SurfaceGeneratorDescriptor[] = [
  {
    id: 'ivy',
    label: 'Ivy',
    shortLabel: 'Ivy',
    code: 'IV',
    family: 'vegetation',
    description: 'Paint branching ivy across the selected surface.',
    capabilities: IVY_CAPABILITIES,
  },
  {
    id: 'tree',
    label: 'Tree',
    shortLabel: 'Tree',
    code: 'TR',
    family: 'vegetation',
    description: 'Grow a procedural banyan from the ground.',
    capabilities: TREE_CAPABILITIES,
  },
  {
    id: 'crystals',
    label: 'Crystals',
    shortLabel: 'Crystals',
    code: 'CR',
    family: 'decor',
    description: 'Grow animated crystal clusters along projected strokes.',
    capabilities: SURFACE_BRUSH_CAPABILITIES,
  },
  {
    id: 'molten',
    label: 'Molten fissures',
    shortLabel: 'Molten',
    code: 'MF',
    family: 'decor',
    description: 'Draw branching emissive cracks across the target.',
    capabilities: SURFACE_BRUSH_CAPABILITIES,
  },
  {
    id: 'aurora',
    label: 'Aurora silk',
    shortLabel: 'Aurora',
    code: 'AU',
    family: 'decor',
    description: 'Unfurl luminous curtains along projected paths.',
    capabilities: SURFACE_BRUSH_CAPABILITIES,
  },
  {
    id: 'reef',
    label: 'Bioluminescent reef',
    shortLabel: 'Reef',
    code: 'RF',
    family: 'decor',
    description: 'Grow pulsing reef colonies across the surface.',
    capabilities: SURFACE_BRUSH_CAPABILITIES,
  },
  {
    id: 'chrome-crayon',
    label: 'Chrome Crayon',
    shortLabel: 'Crayon',
    code: 'CC',
    family: 'blender',
    description: 'Evaluate the Blender-authored Chrome Crayon graph.',
    capabilities: SURFACE_BRUSH_CAPABILITIES,
  },
  {
    id: 'periodic-brush',
    label: 'Periodic Brush',
    shortLabel: 'Periodic',
    code: 'PB',
    family: 'blender',
    description: 'Repeat the Blender periodic brush along the stroke.',
    capabilities: SURFACE_BRUSH_CAPABILITIES,
  },
  {
    id: 'typewriter',
    label: 'Typewriter',
    shortLabel: 'Typewriter',
    code: 'TY',
    family: 'blender',
    description: 'Wrap generated type along a projected stroke.',
    capabilities: SURFACE_BRUSH_CAPABILITIES,
  },
  {
    id: 'stamp',
    label: 'Stamp',
    shortLabel: 'Stamp',
    code: 'ST',
    family: 'blender',
    description: 'Repeat a library object along a projected stroke.',
    capabilities: SURFACE_BRUSH_CAPABILITIES,
  },
] as const;

const GENERATOR_BY_ID = new Map(SURFACE_GENERATORS.map((generator) => [generator.id, generator]));

export function surfaceGenerator(id: SurfaceGeneratorId): SurfaceGeneratorDescriptor {
  const descriptor = GENERATOR_BY_ID.get(id);
  if (!descriptor) throw new Error(`Unknown surface generator: ${id}`);
  return descriptor;
}

