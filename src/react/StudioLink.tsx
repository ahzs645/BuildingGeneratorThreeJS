import { appHref } from "../base-url";

export function StudioLink(): React.JSX.Element {
  return <a id="home" className="studio-link" href={appHref()}>← studio</a>;
}
