import { useCallback, useEffect, useRef, useState } from "react";
import {
  mountBlendStudioRuntime,
  type BlendStudioEvaluation,
  type BlendStudioGizmoConfiguration,
  type BlendStudioMeasurementConfiguration,
  type BlendStudioMeasurementSubjectSnapshot,
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
  const configureMeasurement = useCallback(
    (configuration: BlendStudioMeasurementConfiguration | null): void =>
      controllerRef.current?.configureMeasurement(configuration),
    [],
  );
  const configureGizmos = useCallback(
    (configuration: BlendStudioGizmoConfiguration | null): void =>
      controllerRef.current?.configureGizmos(configuration),
    [],
  );
  const loadMeasurementSubject = useCallback(
    (
      file: File,
      millimetersPerUnit: number,
    ): Promise<BlendStudioMeasurementSubjectSnapshot> =>
      controllerRef.current?.loadMeasurementSubject(file, millimetersPerUnit)
      ?? Promise.reject(new Error("The 3D viewport is not ready")),
    [],
  );
  const clearMeasurementSubject = useCallback(
    (): void => controllerRef.current?.clearMeasurementSubject(),
    [],
  );

  return {
    canvasRef,
    snapshot,
    queue,
    evaluate,
    cancel,
    configureMeasurement,
    configureGizmos,
    loadMeasurementSubject,
    clearMeasurementSubject,
  };
}
