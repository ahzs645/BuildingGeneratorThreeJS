import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from "react";
import { useStudioChrome } from "./StudioChrome";
import { StudioRail } from "./StudioRail";
import "./studio-shell.css";

// Must match the mobile breakpoint in studio-kit.css. Docks and the bottom
// sheet are exclusive render paths (never CSS-hidden duplicates) so hidden
// file inputs, ids, and event handlers inside dock content exist exactly once.
// The second clause keeps touch phones on the sheet in landscape (e.g.
// 844x390), where desktop docks would swallow the screen; fine-pointer
// desktops never match it.
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

export type StudioSheetTab = { id: string; label: string; content: ReactNode };

type StudioPanelHeaderProps = {
  title: ReactNode;
  meta?: ReactNode;
  className?: string;
};

/** A section label for docks that do not actually switch between tabs. */
export function StudioPanelHeader({
  title,
  meta,
  className = "",
}: StudioPanelHeaderProps): React.JSX.Element {
  return <header className={`st-panel-header ${className}`}>
    <h2>{title}</h2>
    {meta && <span>{meta}</span>}
  </header>;
}

type StudioShellProps = {
  /** 300px left dock. Omit to collapse the column to 0. */
  leftDock?: ReactNode;
  /** 320px right inspector. Omit to collapse the column to 0. */
  rightDock?: ReactNode;
  /** 34px `.st-toolbar` above the canvas. */
  toolbar?: ReactNode;
  /** 30px `.st-statusbar` under the canvas — the tool's only status treatment. */
  status?: ReactNode;
  /** A `.st-node-dock` element, docked between the canvas and the status bar. */
  nodeDock?: ReactNode;
  /** Viewport contents: the canvas plus any in-viewport overlays. */
  children: ReactNode;
  /**
   * Mobile bottom-sheet tabs. Defaults to Controls/Details built from the two
   * docks; pass explicit tabs to split a dock across more than one.
   */
  sheetTabs?: StudioSheetTab[];
  className?: string;
  /** For tools whose runtime mounts against the whole body element. */
  bodyRef?: Ref<HTMLElement>;
};

/**
 * The workbench body: row 2 of the `.st-shell` grid, itself a grid of
 * `rail | dock | viewport | inspector`. Docks are columns, not floating
 * panels, so nothing can ever cover the geometry being edited. On mobile the
 * columns collapse and the docks re-render into one bottom sheet.
 */
export function StudioShell({
  leftDock,
  rightDock,
  toolbar,
  status,
  nodeDock,
  children,
  sheetTabs,
  className = "",
  bodyRef,
}: StudioShellProps): React.JSX.Element {
  const isMobile = useMobileStudio();
  const { capture, setHasDocks } = useStudioChrome();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTab, setSheetTab] = useState(0);
  const hasDockContent = Boolean(leftDock ?? rightDock);

  const tabs: StudioSheetTab[] = sheetTabs ?? [
    ...(leftDock ? [{ id: "controls", label: "Controls", content: leftDock }] : []),
    ...(rightDock ? [{ id: "details", label: "Details", content: rightDock }] : []),
  ];

  // The nav's panel toggle only appears for pages that actually have docks.
  useEffect(() => {
    setHasDocks(hasDockContent && !capture);
    return () => setHasDocks(false);
  }, [capture, hasDockContent, setHasDocks]);

  // One class set per layout, never both: the collapse modifiers and the
  // single-column rule would otherwise fight over the same specificity.
  const columns = capture || isMobile
    ? "st-body-plain"
    : `has-rail ${leftDock ? "has-left" : "no-left"} ${rightDock ? "has-right" : "no-right"}`;
  // ?capture hides the rail, the docks, the toolbar, and the status bar, but
  // only the rail stops rendering: imperative runtimes resolve their controls
  // and readouts by id inside the other three and would throw if the only copy
  // left the DOM, so `.st-shell.is-capture` hides those with CSS instead. The
  // mobile sheet is still skipped, so no duplicate control ever exists.
  const docked = capture || !isMobile;

  return <main ref={bodyRef} className={`st-body ${columns} ${className}`}>
    {!isMobile && !capture && <StudioRail />}
    {docked && leftDock && <aside className="st-dock st-dock-left">{leftDock}</aside>}
    <div className="st-viewport-col">
      {toolbar && <div className="st-toolbar">{toolbar}</div>}
      <div className="st-viewport">{children}</div>
      {nodeDock}
      {status && <div className="st-statusbar">{status}</div>}
    </div>
    {docked && rightDock && <aside className="st-dock st-dock-right">{rightDock}</aside>}
    {isMobile && !capture && tabs.length > 0 && <div className={`st-sheet ${sheetOpen ? "is-open" : "is-collapsed"}`}>
      <button type="button" className="st-sheet-handle" aria-expanded={sheetOpen} onClick={() => setSheetOpen((open) => !open)}>
        <span className="st-sheet-grip" aria-hidden="true" />
        <span>{sheetOpen ? "Hide panels" : tabs.map((tab) => tab.label).join(" · ")}</span>
      </button>
      <div className="st-sheet-body" hidden={!sheetOpen}>
        {tabs.length > 1 && <div className="st-segmented" role="tablist" aria-label="Studio panels">
          {tabs.map((tab, index) => <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={sheetTab === index}
            className={sheetTab === index ? "active" : ""}
            onClick={() => setSheetTab(index)}
          >{tab.label}</button>)}
        </div>}
        {tabs.map((tab, index) => <div className="st-sheet-panel" key={tab.id} hidden={sheetTab !== index}>{tab.content}</div>)}
      </div>
    </div>}
  </main>;
}

type StudioOverlayProps = {
  title: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
};

/**
 * The mobile full-screen inspection overlay — the phone counterpart of the
 * docked node editor. Desktop has no floating panel any more: drag, resize,
 * and window bookkeeping are gone with it.
 */
export function StudioOverlay({
  title,
  actions,
  onClose,
  children,
  className = "",
}: StudioOverlayProps): React.JSX.Element {
  return <section className={`st-overlay ${className}`}>
    <header>
      <b>{title}</b>
      <div>
        {actions}
        <button type="button" className="st-btn st-overlay-close" onClick={onClose}>Close ✕</button>
      </div>
    </header>
    <div className="st-overlay-body">{children}</div>
  </section>;
}
