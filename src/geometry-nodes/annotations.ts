import type {
  Dump,
  DumpAnnotation,
  DumpAnnotationFrame,
  DumpAnnotationLayer,
  DumpAnnotationPoint,
} from "../gnvm/dump-schema";

export type FlowBounds = { x: number; y: number; width: number; height: number };

export interface ActiveAnnotationLayer {
  annotation: string;
  layer: DumpAnnotationLayer;
  frame: DumpAnnotationFrame;
}

export interface BoundsNode {
  absolutePosition: { x: number; y: number };
  width: number;
  height: number;
}

/** Select the frame Blender displays for one legacy annotation layer. */
export function resolveAnnotationFrame(
  layer: DumpAnnotationLayer,
  sceneFrame: number,
): DumpAnnotationFrame | null {
  if (!layer.frames.length) return null;
  if (layer.frame_locked && layer.active_frame != null) {
    return layer.frames.find((frame) => frame.number === layer.active_frame) ?? null;
  }
  const ordered = [...layer.frames].sort((a, b) => a.number - b.number);
  let selected = ordered[0];
  for (const frame of ordered) {
    if (frame.number > sceneFrame) break;
    selected = frame;
  }
  return selected;
}

export function activeAnnotationLayers(
  dump: Dump,
  groupName: string,
): ActiveAnnotationLayer[] {
  const group = dump.node_groups[groupName];
  const name = group?.annotation;
  const annotation: DumpAnnotation | undefined = name ? dump.annotations?.[name] : undefined;
  if (!name || !annotation) return [];
  const sceneFrame = Number(dump.scene?.frame_current ?? 0);
  return annotation.layers.flatMap((layer) => {
    if (layer.hidden) return [];
    const frame = resolveAnnotationFrame(layer, sceneFrame);
    return frame ? [{ annotation: name, layer, frame }] : [];
  });
}

export function annotationPointToFlow(point: DumpAnnotationPoint): { x: number; y: number } {
  return { x: point[0], y: -point[1] };
}

function includePoint(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  x: number,
  y: number,
): void {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.maxY = Math.max(bounds.maxY, y);
}

function finishBounds(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): FlowBounds | null {
  if (!Number.isFinite(bounds.minX)) return null;
  return {
    x: bounds.minX,
    y: bounds.minY,
    width: Math.max(1, bounds.maxX - bounds.minX),
    height: Math.max(1, bounds.maxY - bounds.minY),
  };
}

export function annotationBounds(layers: ActiveAnnotationLayer[]): FlowBounds | null {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const { frame } of layers) {
    for (const stroke of frame.strokes) {
      if (stroke.space !== "VIEW2D") continue;
      for (const point of stroke.points) {
        const flow = annotationPointToFlow(point);
        includePoint(bounds, flow.x, flow.y);
      }
    }
  }
  return finishBounds(bounds);
}

/** Union authored node rectangles and current annotation strokes. */
export function documentBounds(
  nodes: BoundsNode[],
  layers: ActiveAnnotationLayer[],
): FlowBounds {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const node of nodes) {
    includePoint(bounds, node.absolutePosition.x, node.absolutePosition.y);
    includePoint(bounds, node.absolutePosition.x + Math.max(1, node.width), node.absolutePosition.y + Math.max(1, node.height));
  }
  const ink = annotationBounds(layers);
  if (ink) {
    includePoint(bounds, ink.x, ink.y);
    includePoint(bounds, ink.x + ink.width, ink.y + ink.height);
  }
  return finishBounds(bounds) ?? { x: 0, y: 0, width: 1, height: 1 };
}

export function projectFlowPoint(
  point: { x: number; y: number },
  viewport: { x: number; y: number; zoom: number },
): { x: number; y: number } {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  };
}
