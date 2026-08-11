import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { installRangeFill } from "./range-fill";

/**
 * The shell's tone vocabulary. `.st-dot` is the only status affordance in the
 * app, so every "is it working" signal — nav chip, status bar, source card —
 * resolves to one of these. `busy` is working, `warn` is working but degraded;
 * both read amber. Never signal state a second way (recolouring the label,
 * swapping a word) — the dot is the signal.
 */
export type StudioTone = "idle" | "ready" | "busy" | "warn" | "error";

export type StudioChip = { id: string; label: string; tone?: StudioTone };

/**
 * Chip publishers, in the order they render. Two exist so the automatic
 * runtime chip and a page's own chips can coexist: before this was keyed, the
 * last hook to run replaced the other's chips wholesale, which is why only two
 * routes in the app ever showed one.
 */
export type StudioChipGroup = "runtime" | "page";

type StudioChromeValue = {
  /** Chips rendered at the right of the top nav, filled by the active page. */
  chips: readonly StudioChip[];
  setChipGroup: (group: StudioChipGroup, chips: readonly StudioChip[]) => void;
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

const CHIP_ORDER: StudioChipGroup[] = ["runtime", "page"];

export function StudioChromeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { search } = useLocation();
  const capture = new URLSearchParams(search).has("capture");
  const [chipGroups, setChipGroups] = useState<Partial<Record<StudioChipGroup, readonly StudioChip[]>>>({});
  const [docksOpen, setDocksOpen] = useState(true);
  const [hasDocks, setHasDocks] = useState(false);
  const setChipGroup = useCallback((group: StudioChipGroup, chips: readonly StudioChip[]) => {
    setChipGroups((current) => ({ ...current, [group]: chips }));
  }, []);
  const chips = useMemo(
    () => CHIP_ORDER.flatMap((group) => chipGroups[group] ?? []),
    [chipGroups],
  );
  const value = useMemo(
    () => ({ chips, setChipGroup, docksOpen, setDocksOpen, hasDocks, setHasDocks, capture }),
    [capture, chips, docksOpen, hasDocks, setChipGroup],
  );
  // Fill-bar sliders need their percentage published to the DOM. Installed on
  // <body>, not the shell: lil-gui panels and the portaled modals live outside
  // it, and their sliders are the same widget.
  useEffect(() => installRangeFill(document.body), []);

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

function usePublishedChips(group: StudioChipGroup, chips: readonly StudioChip[]): void {
  const { setChipGroup } = useStudioChrome();
  const signature = JSON.stringify(chips);
  useEffect(() => {
    setChipGroup(group, JSON.parse(signature) as StudioChip[]);
    return () => setChipGroup(group, []);
  }, [group, setChipGroup, signature]);
}

/**
 * Publish this page's nav status chips. The array may be rebuilt every render:
 * only a change in chip content re-publishes. Chips clear on unmount.
 */
export function useStudioStatusChips(chips: readonly StudioChip[]): void {
  usePublishedChips("page", chips);
}

/**
 * The chip every tool gets for free: whether its runtime is starting, live, or
 * failed. Published by the runtime hooks in page-runtime.ts rather than by each
 * page, so the nav's chip track means the same thing on all ten routes instead
 * of being empty on eight of them.
 */
export function useStudioRuntimeChip(label: string, tone: StudioTone): void {
  usePublishedChips("runtime", useMemo(() => [{ id: "runtime", label, tone }], [label, tone]));
}
