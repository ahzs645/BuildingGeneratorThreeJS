import { useEffect, useRef } from "react";
import type { Viewport } from "@xyflow/react";
import type { GraphNode } from "../../geometry-nodes/graph-model";
import {
  annotationPointToFlow,
  projectFlowPoint,
  type ActiveAnnotationLayer,
  type FlowBounds,
} from "../../geometry-nodes/annotations";

type AnnotationCanvasProps = {
  layers: ActiveAnnotationLayer[];
  viewport: Viewport;
  visible: boolean;
};

function prepareCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}

function color(layer: ActiveAnnotationLayer["layer"]): string {
  const [r = 0.8, g = 0.8, b = 0.2] = layer.color ?? [];
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

export function AnnotationCanvas({ layers, viewport, visible }: AnnotationCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let animationFrame = 0;
    const draw = (): void => {
      const context = prepareCanvas(canvas);
      if (!context || !visible) return;
      context.lineJoin = "round";
      context.lineCap = "round";
      for (const active of layers) {
        context.strokeStyle = color(active.layer);
        for (const stroke of active.frame.strokes) {
          if (stroke.space !== "VIEW2D" || !stroke.points.length) continue;
          const authoredThickness = Math.max(1, Number(active.layer.thickness || stroke.thickness || 1));
          if (stroke.points.length === 1) {
            const point = projectFlowPoint(annotationPointToFlow(stroke.points[0]), viewport);
            const radius = Math.max(0.5, authoredThickness * Math.max(stroke.points[0][3] || 1, 0.01) / 2);
            context.globalAlpha = Math.max(0, Math.min(1, active.layer.opacity * (stroke.points[0][4] ?? 1)));
            context.fillStyle = color(active.layer);
            context.beginPath();
            context.arc(point.x, point.y, radius, 0, Math.PI * 2);
            context.fill();
            continue;
          }
          for (let index = 1; index < stroke.points.length; index += 1) {
            const previous = stroke.points[index - 1];
            const current = stroke.points[index];
            const start = projectFlowPoint(annotationPointToFlow(previous), viewport);
            const end = projectFlowPoint(annotationPointToFlow(current), viewport);
            const pressure = Math.max(0.01, ((previous[3] || 1) + (current[3] || 1)) / 2);
            const strength = Math.max(0, Math.min(1, ((previous[4] ?? 1) + (current[4] ?? 1)) / 2));
            context.globalAlpha = Math.max(0, Math.min(1, active.layer.opacity * strength));
            // Blender annotation thickness is screen-space, not graph-space.
            context.lineWidth = Math.max(1, authoredThickness * pressure);
            context.beginPath();
            context.moveTo(start.x, start.y);
            context.lineTo(end.x, end.y);
            context.stroke();
          }
        }
      }
      context.globalAlpha = 1;
    };
    const schedule = (): void => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(draw);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(animationFrame);
    };
  }, [layers, viewport, visible]);

  return <canvas ref={canvasRef} className="annotation-canvas" aria-hidden="true" />;
}

type AnnotationMiniMapProps = {
  bounds: FlowBounds;
  nodes: GraphNode[];
  layers: ActiveAnnotationLayer[];
  viewport: Viewport;
  visible: boolean;
  onCenter: (x: number, y: number) => void;
};

function miniTransform(bounds: FlowBounds, width: number, height: number): {
  scale: number;
  x: (value: number) => number;
  y: (value: number) => number;
  invert: (x: number, y: number) => { x: number; y: number };
} {
  const padding = 6;
  const scale = Math.min(
    (width - padding * 2) / Math.max(1, bounds.width),
    (height - padding * 2) / Math.max(1, bounds.height),
  );
  const offsetX = (width - bounds.width * scale) / 2 - bounds.x * scale;
  const offsetY = (height - bounds.height * scale) / 2 - bounds.y * scale;
  return {
    scale,
    x: (value) => value * scale + offsetX,
    y: (value) => value * scale + offsetY,
    invert: (x, y) => ({ x: (x - offsetX) / scale, y: (y - offsetY) / scale }),
  };
}

export function AnnotationMiniMap({ bounds, nodes, layers, viewport, visible, onCenter }: AnnotationMiniMapProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = prepareCanvas(canvas);
    if (!context) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const transform = miniTransform(bounds, width, height);
    context.fillStyle = "rgba(10,12,15,.92)";
    context.fillRect(0, 0, width, height);
    for (const node of nodes) {
      context.fillStyle = node.kind === "frame" ? "rgba(70,76,82,.45)" : "rgba(91,126,109,.9)";
      context.fillRect(
        transform.x(node.absolutePosition.x),
        transform.y(node.absolutePosition.y),
        Math.max(1, node.width * transform.scale),
        Math.max(1, node.height * transform.scale),
      );
    }
    if (visible) {
      for (const active of layers) {
        context.strokeStyle = color(active.layer);
        context.globalAlpha = Math.max(0.25, active.layer.opacity);
        context.lineWidth = 1;
        for (const stroke of active.frame.strokes) {
          if (stroke.space !== "VIEW2D" || stroke.points.length < 2) continue;
          context.beginPath();
          stroke.points.forEach((point, index) => {
            const flow = annotationPointToFlow(point);
            const x = transform.x(flow.x);
            const y = transform.y(flow.y);
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          });
          context.stroke();
        }
      }
    }
    context.globalAlpha = 1;
    const parent = canvas.parentElement;
    const flowWidth = Math.max(1, parent?.clientWidth ?? width);
    const flowHeight = Math.max(1, parent?.clientHeight ?? height);
    const viewX = -viewport.x / viewport.zoom;
    const viewY = -viewport.y / viewport.zoom;
    context.strokeStyle = "rgba(230,238,242,.82)";
    context.lineWidth = 1;
    context.strokeRect(
      transform.x(viewX),
      transform.y(viewY),
      flowWidth / viewport.zoom * transform.scale,
      flowHeight / viewport.zoom * transform.scale,
    );
  }, [bounds, layers, nodes, viewport, visible]);

  return <canvas
    ref={canvasRef}
    className="annotation-minimap"
    aria-label="Node graph minimap"
    onPointerDown={(event) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const transform = miniTransform(bounds, canvas.clientWidth, canvas.clientHeight);
      const point = transform.invert(event.clientX - rect.left, event.clientY - rect.top);
      onCenter(point.x, point.y);
    }}
  />;
}
