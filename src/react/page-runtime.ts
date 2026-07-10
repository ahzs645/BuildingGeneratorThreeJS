import { useEffect } from "react";

export function usePageRuntime(title: string, load?: () => Promise<unknown>): void {
  useEffect(() => {
    document.title = title;
    if (load) void load();
  }, [load, title]);
}
