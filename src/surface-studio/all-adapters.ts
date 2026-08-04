import {
  chromeCrayonAdapter,
  periodicBrushAdapter,
  stampAdapter,
  typewriterAdapter,
} from './blender-gn-adapters';
import { ivyAdapter } from './ivy-adapter';
import { PROCEDURAL_PAINT_ADAPTERS } from './procedural-adapters';
import { treeAdapter } from './tree-adapter';

/** Canonical runtime registry used by the unified Surface Painting Studio. */
export const SURFACE_STUDIO_ADAPTERS = [
  ivyAdapter,
  treeAdapter,
  ...PROCEDURAL_PAINT_ADAPTERS,
  chromeCrayonAdapter,
  periodicBrushAdapter,
  typewriterAdapter,
  stampAdapter,
] as const;

