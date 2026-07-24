import { useCallback, useEffect, useRef, useState } from "react";
import {
  mountBlendStudioRuntime,
  type BlendStudioEvaluation,
  type BlendStudioRuntimeController,
  type BlendStudioRuntimeSnapshot,
} from "../../blend-studio/runtime";

const INITIAL_STATE: BlendStudioRuntimeSnapshot = {
  state: "idle",
  message: "Import a Blender graph to begin",
  lastValid: false,
};

export function useBlendStudioRuntime() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<BlendStudioRuntimeController | null>(null);
  const [snapshot, setSnapshot] = useState(INITIAL_STATE);

  useEffect(() => {
    if (!canvasRef.current) return;
    const controller = mountBlendStudioRuntime({
      canvas: canvasRef.current,
      onState: setSnapshot,
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, []);

  const queue = useCallback((request: BlendStudioEvaluation): void =>
    controllerRef.current?.queue(request), []);
  const evaluate = useCallback((request: BlendStudioEvaluation): Promise<void> =>
    controllerRef.current?.evaluate(request) ?? Promise.resolve(), []);
  const cancel = useCallback((): void => controllerRef.current?.cancel(), []);

  return { canvasRef, snapshot, queue, evaluate, cancel };
}
