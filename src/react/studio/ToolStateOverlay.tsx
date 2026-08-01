import type { ToolRuntimeState } from "../page-runtime";

export function ToolStateOverlay({ state }: { state: ToolRuntimeState }): React.JSX.Element | null {
  if (state.phase === "ready") return null;
  if (state.phase === "loading") {
    return <div className="st-tool-state" role="status" aria-live="polite">
      <span className="st-tool-state-spinner" aria-hidden="true" />
      <b>Starting tool…</b>
      <small>Loading the renderer and authored assets</small>
    </div>;
  }
  return <div className="st-tool-state is-error" role="alert">
    <span className="st-dot error" aria-hidden="true" />
    <b>This tool could not start</b>
    <small>{state.error?.message ?? "An unknown startup error occurred."}</small>
    <button type="button" className="st-btn-primary" onClick={state.retry}>Try again</button>
  </div>;
}
