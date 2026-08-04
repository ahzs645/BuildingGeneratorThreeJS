import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

/**
 * The shell's tone vocabulary. `.st-dot` is the only status affordance in the
 * app, so every "is it working" signal — nav chip, status bar, source card —
 * resolves to one of these. `busy` is working, `warn` is working but degraded;
 * both read amber. Never signal state a second way (recolouring the label,
 * swapping a word) — the dot is the signal.
 */
export type StudioTone = "idle" | "ready" | "busy" | "warn" | "error";

export type StudioChip = { id: string; label: string; tone?: StudioTone };

type StudioChromeValue = {
  /** Chips rendered at the right of the top nav, filled by the active page. */
  chips: readonly StudioChip[];
  setChips: (chips: readonly StudioChip[]) => void;
  /** Collapses the dock grid columns to 0 (`.st-shell.docks-closed`). */
  docksOpen: boolean;
  setDocksOpen: (open: boolean) => void;
  /** True while the mounted page actually renders docks worth collapsing. */
  hasDocks: boolean;
  setHasDocks: (has: boolean) => void;
  /** `?capture` — headless parity screenshots must contain no chrome at all. */
  capture: boolean;
};

const StudioChromeContext = createContext<StudioChromeValue | null>(null);

export function StudioChromeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { search } = useLocation();
  const capture = new URLSearchParams(search).has("capture");
  const [chips, setChips] = useState<readonly StudioChip[]>([]);
  const [docksOpen, setDocksOpen] = useState(true);
  const [hasDocks, setHasDocks] = useState(false);
  const value = useMemo(
    () => ({ chips, setChips, docksOpen, setDocksOpen, hasDocks, setHasDocks, capture }),
    [capture, chips, docksOpen, hasDocks],
  );
  // The shell owns the whole viewport: nav row + body row. Nothing inside is
  // position:fixed except the mobile sheet, so no panel can cover the viewport.
  return <StudioChromeContext.Provider value={value}>
    <div className={`st-shell ${docksOpen ? "docks-open" : "docks-closed"} ${capture ? "is-capture" : ""}`}>
      {children}
    </div>
  </StudioChromeContext.Provider>;
}

export function useStudioChrome(): StudioChromeValue {
  const value = useContext(StudioChromeContext);
  if (!value) throw new Error("useStudioChrome must be used inside StudioChromeProvider");
  return value;
}

/** True while the route asked for chrome-free capture output. */
export function useStudioCapture(): boolean {
  return useStudioChrome().capture;
}

/**
 * Publish this page's nav status chips. The array may be rebuilt every render:
 * only a change in chip content re-publishes. Chips clear on unmount.
 */
export function useStudioStatusChips(chips: readonly StudioChip[]): void {
  const { setChips } = useStudioChrome();
  const signature = JSON.stringify(chips);
  useEffect(() => {
    setChips(JSON.parse(signature) as StudioChip[]);
    return () => setChips([]);
  }, [setChips, signature]);
}
