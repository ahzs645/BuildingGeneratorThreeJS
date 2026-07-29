import { Fragment } from "react";
import { Link, useLocation } from "react-router-dom";
import { findStudioTool, STUDIO_TOOLS } from "./StudioMenu";

/**
 * The 56px tool rail: one entry per section of STUDIO_TOOLS, linking to that
 * section's first tool. Marks are CSS shapes (`.st-mark-*` in studio-nav.css),
 * never icon assets, so the rail costs nothing to ship and stays legible at
 * the 9px mono label size the kit allows here.
 */
export function StudioRail(): React.JSX.Element {
  const { pathname } = useLocation();
  const active = findStudioTool(pathname)?.section.title;
  return <nav className="st-rail" aria-label="Studio sections">
    {STUDIO_TOOLS.map((section) => {
      const current = section.title === active;
      return <Fragment key={section.title}>
        {section.railBreak && <hr />}
        <Link
          to={section.items[0].href}
          aria-current={current ? "page" : undefined}
          title={`${section.title} · ${section.items.map((item) => item.title).join(", ")}`}
        >
          <span className={`st-mark st-mark-${section.mark}`} aria-hidden="true" />
          {section.label.toUpperCase()}
        </Link>
      </Fragment>;
    })}
  </nav>;
}
