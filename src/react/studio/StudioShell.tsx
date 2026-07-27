import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { StudioMenuButton } from "./StudioMenu";
import "./studio-shell.css";

export type StudioPanelRect = { x: number; y: number; width: number; height: number };

// Must match the mobile breakpoint in studio-shell.css. Docks and the bottom
// sheet are exclusive render paths (never CSS-hidden duplicates) so hidden
// file inputs, ids, and event handlers inside dock content exist exactly once.
// The second clause keeps touch phones on the sheet in landscape (e.g.
// 844x390), where desktop docks and floating panels would swallow the screen;
// fine-pointer desktops never match it.
export const MOBILE_STUDIO_QUERY = "(max-width: 820px), ((pointer: coarse) and (max-height: 500px))";

function subscribeToMobileStudio(onChange: () => void): () => void {
  const media = window.matchMedia(MOBILE_STUDIO_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function isMobileStudioViewport(): boolean {
  return window.matchMedia(MOBILE_STUDIO_QUERY).matches;
}

/**
 * Shared mobile-studio breakpoint. Pages and panels must read the viewport
 * through this hook (never a duplicated query string) so the React render
 * paths can never disagree with the CSS media query above.
 */
export function useMobileStudio(): boolean {
  return useSyncExternalStore(subscribeToMobileStudio, isMobileStudioViewport);
}

type StudioShellProps = {
  eyebrow: string;
  title: string;
  subtitle: ReactNode;
  docksOpen: boolean;
  onToggleDocks: () => void;
  leftDock?: ReactNode;
  rightDock?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
};

export function StudioShell({
  eyebrow,
  title,
  subtitle,
  docksOpen,
  onToggleDocks,
  leftDock,
  rightDock,
  children,
  footer,
}: StudioShellProps): React.JSX.Element {
  const isMobile = useMobileStudio();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTab, setSheetTab] = useState<"controls" | "details">("controls");
  const hasDockContent = Boolean(leftDock ?? rightDock);
  const toggleSheet = (): void => setSheetOpen((open) => !open);

  return <main className={`studio-shell ${docksOpen ? "docks-open" : "docks-closed"}`}>
    <div className="studio-viewport">{children}</div>
    <header className="studio-brand">
      <StudioMenuButton className="studio-home" title="Studio tools (⌘K)">PS</StudioMenuButton>
      <div>
        <span>{eyebrow}</span>
        <strong>{title}</strong>
        <small>{subtitle}</small>
      </div>
      {isMobile
        ? hasDockContent && <button type="button" onClick={toggleSheet} aria-pressed={sheetOpen} title={sheetOpen ? "Collapse studio panels" : "Expand studio panels"}>
            {sheetOpen ? "Hide panels" : "Show panels"}
          </button>
        : <button type="button" onClick={onToggleDocks} aria-pressed={docksOpen} title={docksOpen ? "Hide studio docks" : "Show studio docks"}>
            {docksOpen ? "Hide panels" : "Show panels"}
          </button>}
    </header>
    {!isMobile && leftDock && <aside className="studio-dock studio-dock-left">{leftDock}</aside>}
    {!isMobile && rightDock && <aside className="studio-dock studio-dock-right">{rightDock}</aside>}
    {isMobile && hasDockContent && <div className={`studio-sheet ${sheetOpen ? "is-open" : "is-collapsed"}`}>
      <button type="button" className="studio-sheet-handle" aria-expanded={sheetOpen} onClick={toggleSheet}>
        <span className="studio-sheet-grip" aria-hidden="true" />
        <span className="studio-sheet-title">{sheetOpen ? "Hide studio panels" : "Studio panels"}</span>
      </button>
      <div className="studio-sheet-body" hidden={!sheetOpen}>
        {leftDock && rightDock && <div className="studio-sheet-tabs" role="tablist" aria-label="Studio panels">
          <button type="button" role="tab" aria-selected={sheetTab === "controls"} className={sheetTab === "controls" ? "active" : ""} onClick={() => setSheetTab("controls")}>Controls</button>
          <button type="button" role="tab" aria-selected={sheetTab === "details"} className={sheetTab === "details" ? "active" : ""} onClick={() => setSheetTab("details")}>Details</button>
        </div>}
        {leftDock && <div className="studio-sheet-panel" hidden={Boolean(rightDock) && sheetTab !== "controls"}>{leftDock}</div>}
        {rightDock && <div className="studio-sheet-panel" hidden={Boolean(leftDock) && sheetTab !== "details"}>{rightDock}</div>}
      </div>
    </div>}
    {footer && <footer className="studio-footer">{footer}</footer>}
  </main>;
}

type FloatingStudioPanelProps = {
  rect: StudioPanelRect;
  onRectChange: (rect: StudioPanelRect) => void;
  maximized: boolean;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  minWidth?: number;
  minHeight?: number;
  className?: string;
  /**
   * Renders a prominent Close button on the mobile full-screen overlay.
   * Ignored on desktop, where pages pass their own Hide action instead.
   */
  onClose?: () => void;
};

type Gesture =
  | { mode: "move"; startX: number; startY: number; rect: StudioPanelRect }
  | { mode: "resize"; edge: string; startX: number; startY: number; rect: StudioPanelRect };

const VIEWPORT_PAD = 10;

function clampRect(rect: StudioPanelRect, minWidth: number, minHeight: number): StudioPanelRect {
  const maxWidth = Math.max(minWidth, window.innerWidth - VIEWPORT_PAD * 2);
  const maxHeight = Math.max(minHeight, window.innerHeight - VIEWPORT_PAD * 2);
  const width = Math.min(maxWidth, Math.max(minWidth, rect.width));
  const height = Math.min(maxHeight, Math.max(minHeight, rect.height));
  return {
    x: Math.min(Math.max(VIEWPORT_PAD, rect.x), Math.max(VIEWPORT_PAD, window.innerWidth - width - VIEWPORT_PAD)),
    y: Math.min(Math.max(VIEWPORT_PAD, rect.y), Math.max(VIEWPORT_PAD, window.innerHeight - height - VIEWPORT_PAD)),
    width,
    height,
  };
}

export function FloatingStudioPanel({
  rect,
  onRectChange,
  maximized,
  title,
  actions,
  children,
  minWidth = 520,
  minHeight = 320,
  className = "",
  onClose,
}: FloatingStudioPanelProps): React.JSX.Element {
  const isMobile = useMobileStudio();
  const panelRef = useRef<HTMLElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const latestRect = useRef(rect);

  useEffect(() => {
    // Mobile ignores the rect entirely, so never clamp-and-persist it there.
    if (maximized || isMobile) return;
    const onResize = (): void => onRectChange(clampRect(latestRect.current, minWidth, minHeight));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isMobile, maximized, minHeight, minWidth, onRectChange]);

  useEffect(() => {
    latestRect.current = rect;
  }, [rect]);

  const updateGesture = (event: PointerEvent): void => {
    const gesture = gestureRef.current;
    const panel = panelRef.current;
    if (!gesture || !panel) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    let next = { ...gesture.rect };
    if (gesture.mode === "move") {
      next.x += dx;
      next.y += dy;
    } else {
      if (gesture.edge.includes("e")) next.width += dx;
      if (gesture.edge.includes("s")) next.height += dy;
      if (gesture.edge.includes("w")) {
        next.x += dx;
        next.width -= dx;
      }
      if (gesture.edge.includes("n")) {
        next.y += dy;
        next.height -= dy;
      }
    }
    next = clampRect(next, minWidth, minHeight);
    latestRect.current = next;
    panel.style.left = `${next.x}px`;
    panel.style.top = `${next.y}px`;
    panel.style.width = `${next.width}px`;
    panel.style.height = `${next.height}px`;
  };

  const finishGesture = (): void => {
    window.removeEventListener("pointermove", updateGesture);
    window.removeEventListener("pointerup", finishGesture);
    if (gestureRef.current) onRectChange(latestRect.current);
    gestureRef.current = null;
    panelRef.current?.classList.remove("is-gesturing");
  };

  const beginGesture = (mode: "move" | "resize", edge = "") => (event: ReactPointerEvent): void => {
    if (maximized || event.button !== 0) return;
    if (mode === "move" && (event.target as HTMLElement).closest("button,input,select,a,[role='button']")) return;
    event.preventDefault();
    gestureRef.current = mode === "move"
      ? { mode, startX: event.clientX, startY: event.clientY, rect: { ...rect } }
      : { mode, edge, startX: event.clientX, startY: event.clientY, rect: { ...rect } };
    latestRect.current = { ...rect };
    panelRef.current?.classList.add("is-gesturing");
    window.addEventListener("pointermove", updateGesture);
    window.addEventListener("pointerup", finishGesture);
  };

  // Mobile: a full-screen inspection overlay. Drag, resize, and maximize are
  // meaningless there — the rect props are ignored and no gesture ever binds.
  if (isMobile) return <section className={`floating-studio-panel mobile-overlay ${className}`}>
    <header>
      <b>{title}</b>
      <div>
        {actions}
        {onClose && <button type="button" className="panel-mobile-close" onClick={onClose}>Close ✕</button>}
      </div>
    </header>
    <div className="floating-studio-panel-body">{children}</div>
  </section>;

  const panelStyle = maximized
    ? { left: 10, top: 10, width: "calc(100vw - 20px)", height: "calc(100vh - 20px)" }
    : { left: rect.x, top: rect.y, width: rect.width, height: rect.height };

  return <section ref={panelRef} className={`floating-studio-panel ${maximized ? "maximized" : ""} ${className}`} style={panelStyle}>
    <header onPointerDown={beginGesture("move")}>
      <span className="panel-grip" aria-hidden="true">•••</span>
      <b>{title}</b>
      <div>{actions}</div>
    </header>
    <div className="floating-studio-panel-body">{children}</div>
    {!maximized && <>
      {["n", "e", "s", "w", "ne", "se", "sw", "nw"].map((edge) =>
        <span key={edge} className={`panel-resize panel-resize-${edge}`} onPointerDown={beginGesture("resize", edge)} />,
      )}
    </>}
  </section>;
}
