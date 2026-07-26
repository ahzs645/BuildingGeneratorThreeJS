import type {
  Dump,
  DumpAnimationFCurve,
  DumpAnimationKeyframe,
  RawSocket,
} from "./dump-schema";

const NODE_SOCKET_PATH =
  /^nodes\["((?:\\.|[^"])*)"\]\.inputs\[(\d+)\]\.default_value$/;

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  const inverse = 1 - t;
  return inverse ** 3 * a
    + 3 * inverse ** 2 * t * b
    + 3 * inverse * t ** 2 * c
    + t ** 3 * d;
}

function bezierValue(
  left: DumpAnimationKeyframe,
  right: DumpAnimationKeyframe,
  frame: number,
): number {
  const leftHandle = left.handle_right ?? [left.frame, left.value];
  const rightHandle = right.handle_left ?? [right.frame, right.value];
  let low = 0;
  let high = 1;
  // F-curve handles are monotonic in time for Blender's ordinary AUTO/ALIGNED
  // keys. Bisection avoids platform-dependent Newton termination.
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const middle = (low + high) / 2;
    const x = cubic(left.frame, leftHandle[0], rightHandle[0], right.frame, middle);
    if (x < frame) low = middle;
    else high = middle;
  }
  const t = (low + high) / 2;
  return cubic(left.value, leftHandle[1], rightHandle[1], right.value, t);
}

export function evaluateFCurve(curve: DumpAnimationFCurve, frame: number): number {
  const keys = [...curve.keyframes]
    .filter((key) => Number.isFinite(key.frame) && Number.isFinite(key.value))
    .sort((a, b) => a.frame - b.frame);
  if (!keys.length) return 0;
  if (frame <= keys[0].frame) return keys[0].value;
  if (frame >= keys[keys.length - 1].frame) return keys[keys.length - 1].value;
  const rightIndex = keys.findIndex((key) => key.frame >= frame);
  const right = keys[rightIndex];
  const left = keys[rightIndex - 1];
  if (frame === right.frame) return right.value;
  const interpolation = left.interpolation ?? "BEZIER";
  if (interpolation === "CONSTANT") return left.value;
  if (interpolation === "LINEAR") {
    const factor = (frame - left.frame) / Math.max(right.frame - left.frame, 1e-12);
    return left.value + (right.value - left.value) * factor;
  }
  return bezierValue(left, right, frame);
}

function socketAtPath(
  dump: Dump,
  groupName: string,
  dataPath: string,
): RawSocket | undefined {
  const match = NODE_SOCKET_PATH.exec(dataPath);
  if (!match) return undefined;
  let nodeName: string;
  try {
    nodeName = JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
  return dump.node_groups[groupName]?.nodes
    .find((node) => node.name === nodeName)
    ?.inputs[Number(match[2])];
}

export function animationFrameRange(dump: Dump): [number, number] | null {
  const ranges = Object.values(dump.node_groups)
    .flatMap((group) => group.animation?.frame_range ? [group.animation.frame_range] : []);
  if (!ranges.length) return null;
  return [
    Math.min(...ranges.map((range) => finite(range[0], 0))),
    Math.max(...ranges.map((range) => finite(range[1], 0))),
  ];
}

/**
 * Clone a dump and evaluate supported Blender node-tree F-curves at one frame.
 * Unsupported data paths remain preserved in the animation payload and leave
 * graph defaults untouched.
 */
export function dumpAtFrame(dump: Dump, frame: number): Dump {
  const range = animationFrameRange(dump);
  if (!range) return dump;
  const animated = structuredClone(dump);
  for (const [groupName, group] of Object.entries(animated.node_groups)) {
    for (const curve of group.animation?.fcurves ?? []) {
      const socket = socketAtPath(animated, groupName, curve.data_path);
      if (!socket) continue;
      const value = evaluateFCurve(curve, frame);
      if (Array.isArray(socket.value)) {
        const next = [...socket.value];
        next[Math.max(0, curve.array_index)] = value;
        socket.value = next;
      } else {
        socket.value = value;
      }
    }
  }
  animated.scene = { ...(animated.scene ?? {}), frame_current: frame };
  return animated;
}
