import { useCallback, useEffect, useRef, useState } from "react";
import type { Dump } from "../../gnvm";
import type {
  CrayonProbeSelection,
  CrayonRuntimeController,
  CrayonRuntimeSnapshot,
} from "../../crayon-compare";

const INITIAL_STATE: CrayonRuntimeSnapshot = {
  state: "loading",
  message: "Loading portable graph…",
  selectionMessage: "Output preview · final geometry",
  lastValid: false,
};

export function useCrayonRuntime(initialOverrides: Record<string, number>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<CrayonRuntimeController | null>(null);
  const [snapshot, setSnapshot] = useState<CrayonRuntimeSnapshot>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    let mounted: CrayonRuntimeController | null = null;
    void import("../../crayon-compare").then(({ mountCrayonRuntime }) => {
      if (cancelled || !canvasRef.current) return;
      mounted = mountCrayonRuntime({
        canvas: canvasRef.current,
        initialOverrides,
        onState: setSnapshot,
      });
      controllerRef.current = mounted;
    }).catch((error) => setSnapshot({
      ...INITIAL_STATE,
      state: "error",
      message: `Runtime failed · ${error instanceof Error ? error.message : String(error)}`,
    }));
    return () => {
      cancelled = true;
      mounted?.dispose();
      if (controllerRef.current === mounted) controllerRef.current = null;
    };
    // Initial controls are deliberately captured once at renderer boot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setDump = useCallback((dump: Dump): void => controllerRef.current?.setDump(dump), []);
  const setProbe = useCallback((selection?: CrayonProbeSelection): void => controllerRef.current?.setProbe(selection), []);
  const setLayout = useCallback((layout: "split" | "overlay"): void => controllerRef.current?.setLayout(layout), []);
  const setShader = useCallback((shader: "diagnostic" | "chrome"): void => controllerRef.current?.setShader(shader), []);
  const evaluate = useCallback((overrides: Record<string, number>): Promise<void> =>
    controllerRef.current?.evaluate(overrides) ?? Promise.resolve(), []);

  return { canvasRef, snapshot, setDump, setProbe, setLayout, setShader, evaluate };
}
