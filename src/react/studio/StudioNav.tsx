import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { findStudioTool, StudioMenu } from "./StudioMenu";
import "./studio-nav.css";

/**
 * The single, persistent navigation chrome for every studio route: a fixed
 * top bar with the studio mark, a section · tool breadcrumb, one-click links
 * to the sibling tools of the current section, and the full tool directory
 * behind one button (and the only ⌘K registration in the app).
 *
 * Pages must not render their own studio entry points — top-anchored page
 * chrome offsets itself below the bar with var(--studio-nav-h).
 */
export function StudioNav(): React.JSX.Element | null {
  const { pathname, search } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  // Headless parity captures screenshot full pages; no chrome may appear.
  const capture = new URLSearchParams(search).has("capture");

  useEffect(() => {
    if (capture) return;
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setMenuOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capture]);

  if (capture) return null;

  const entry = findStudioTool(pathname);
  const openMenu = (): void => setMenuOpen(true);
  return <>
    <header className="studio-nav">
      <button type="button" className="studio-nav-mark" title="All studio tools (⌘K)" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={openMenu}>PS</button>
      <button type="button" className="studio-nav-crumb" title="All studio tools (⌘K)" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={openMenu}>
        <span>{entry?.section.title ?? "Procedural Studio"}</span>
        <strong>{entry?.tool.title ?? "Procedural Studio"}</strong>
      </button>
      {entry && entry.section.items.length > 1 && <nav className="studio-nav-siblings" aria-label={`${entry.section.title} tools`}>
        {/* Labelled so sibling tools read as section neighbours, not tabs of
            the current tool. */}
        <span className="studio-nav-section" aria-hidden="true">{entry.section.title}</span>
        {entry.section.items.map((item) => {
          const current = item.href === pathname;
          return <Link key={item.href} to={item.href} className={current ? "current" : ""} aria-current={current ? "page" : undefined}>{item.title}</Link>;
        })}
      </nav>}
      <button type="button" className="studio-nav-all" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={openMenu}>All tools <kbd>⌘K</kbd></button>
    </header>
    <StudioMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
  </>;
}
