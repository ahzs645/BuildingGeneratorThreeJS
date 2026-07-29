import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

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
 * useToolRuntime for tools whose React dock drives the runtime: identical
 * lifecycle, but the created handle is returned so the page can call into it.
 * Null until the lazy module has loaded, and again after disposal.
 */
export function useToolController<Handle extends ToolHandle>(
  title: string,
  load: () => Promise<{ createTool(): Handle | Promise<Handle> }>,
): Handle | null {
  const { search } = useLocation();
  const [handle, setHandle] = useState<Handle | null>(null);
  useEffect(() => {
    document.title = title;
    let disposed = false;
    let created: Handle | null = null;
    load()
      .then(async (mod) => {
        const tool = await mod.createTool();
        if (disposed) tool.dispose();
        else {
          created = tool;
          setHandle(tool);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) console.error("Studio tool failed to start", error);
      });
    return () => {
      disposed = true;
      created?.dispose();
      created = null;
      setHandle(null);
    };
  }, [load, search, title]);
  return handle;
}

/**
 * Mount a disposable tool runtime for the lifetime of the page component.
 * The loader must be module-level (stable identity) and resolve to a module
 * exporting createTool(). Runs after render, so the tool can query the DOM
 * the page just rendered.
 */
export function useToolRuntime(title: string, load: () => Promise<ToolModule>): void {
  // Tools read location.search once at mount (capture modes, variant presets).
  // Depending on it here remounts the runtime when router navigation changes
  // only the query string — e.g. dev-menu preset links on the current tool.
  // Tool-initiated history.replaceState does not notify the router, so tools
  // rewriting their own query params never self-remount.
  const { search } = useLocation();
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
  }, [load, search, title]);
}
