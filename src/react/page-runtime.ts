import { useEffect } from "react";

/**
 * A mounted studio tool. dispose() must return the document to the state it
 * was in before createTool() ran: cancel animation loops, remove listeners
 * added to window/document, disconnect observers, destroy GUIs, terminate
 * workers, and release the WebGL/WebGPU context — so tools can be entered
 * and left repeatedly without a page reload.
 */
export type ToolHandle = { dispose(): void };

export type ToolModule = { createTool(): ToolHandle | Promise<ToolHandle> };

export function usePageRuntime(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/**
 * Mount a disposable tool runtime for the lifetime of the page component.
 * The loader must be module-level (stable identity) and resolve to a module
 * exporting createTool(). Runs after render, so the tool can query the DOM
 * the page just rendered.
 */
export function useToolRuntime(title: string, load: () => Promise<ToolModule>): void {
  useEffect(() => {
    document.title = title;
    let disposed = false;
    let handle: ToolHandle | null = null;
    load()
      .then(async (mod) => {
        const created = await mod.createTool();
        if (disposed) created.dispose();
        else handle = created;
      })
      .catch((error: unknown) => {
        if (!disposed) console.error("Studio tool failed to start", error);
      });
    return () => {
      disposed = true;
      handle?.dispose();
      handle = null;
    };
  }, [load, title]);
}
