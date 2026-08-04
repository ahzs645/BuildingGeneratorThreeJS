import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useStudioChrome } from "./StudioChrome";
import { findStudioTool, STUDIO_TOOLS, StudioMenu } from "./StudioMenu";
import "./studio-nav.css";

/**
 * The single, persistent navigation chrome for every studio route: row 1 of
 * the `.st-shell` grid. Left to right — the product wordmark, a section · tool
 * breadcrumb, a centred segmented section switcher, the page's status chips,
 * and the full tool directory behind ⌘K (the only registration in the app).
 *
 * Pages must not render their own studio entry points, headings, or status
 * treatments: the breadcrumb names the tool and the status bar carries state.
 */
export function StudioNav(): React.JSX.Element | null {
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const { chips, docksOpen, setDocksOpen, hasDocks, capture } = useStudioChrome();

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

  // Headless parity captures screenshot full pages; no chrome may appear.
  if (capture) return null;

  const entry = findStudioTool(pathname);
  const openMenu = (): void => setMenuOpen(true);
  return <>
    {/* Three grid tracks, not a flex row with an auto-margin: the switcher has
        to sit at the centre of the bar, not at the centre of whatever space
        the breadcrumb and the chips happen to leave. Pages publish different
        numbers of chips, and an auto margin made the switcher jump ~190px
        between tools. */}
    <header className="st-nav">
      <div className="st-nav-lead">
        <strong className="st-nav-title">Procedural Studio</strong>
        <span className="st-nav-sep" aria-hidden="true" />
        <span className="st-crumb">
          <span className="st-crumb-section">{entry?.section.title ?? "Procedural Studio"}</span>
          <i aria-hidden="true">/</i>
          <strong>{entry?.tool.title ?? "Tool directory"}</strong>
        </span>
      </div>
      <nav className="st-segmented st-nav-sections" aria-label="Studio sections">
        {STUDIO_TOOLS.map((section) => {
          const current = section.title === entry?.section.title;
          return <Link
            key={section.title}
            to={section.items[0].href}
            aria-current={current ? "page" : undefined}
            title={`${section.title} · ${section.items.map((item) => item.title).join(", ")}`}
          >{section.label}</Link>;
        })}
      </nav>
      <div className="st-nav-trail">
        <div className="st-nav-chips">
          {chips.map((chip) => <span className="st-nav-chip" key={chip.id}>
            <span className={`st-dot ${chip.tone ?? ""}`} aria-hidden="true" />
            {chip.label}
          </span>)}
        </div>
        {hasDocks && <button
          type="button"
          className="st-nav-panels"
          aria-pressed={docksOpen}
          onClick={() => setDocksOpen(!docksOpen)}
        >{docksOpen ? "Hide panels" : "Show panels"}</button>}
        <button type="button" className="st-nav-tools" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={openMenu}>
          <span className="st-nav-tools-label">Tools</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
    </header>
    <StudioMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
  </>;
}
