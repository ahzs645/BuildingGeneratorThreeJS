import type { CSSProperties } from "react";

/**
 * Fill-bar sliders, in the shape lil-gui uses: a filled track that reads as a
 * level rather than a rail with a knob on it. The studio already shows that
 * widget in the Surface painter's lil-gui panel, so every other slider in the
 * app matching it is a consistency win as much as a preference.
 *
 * CSS cannot read an `<input type=range>`'s value, and no engine exposes a
 * "filled portion" pseudo-element that both Chromium and WebKit implement
 * (Firefox alone has `::-moz-range-progress`). So the percentage is published
 * to the element as `--st-fill` and the track paints itself from it.
 *
 * Two publishers, because they cover different gaps:
 *
 * - `rangeFillStyle` is for controlled React inputs. It is exact and needs no
 *   listener — the value and the fill are written in the same render.
 * - `installRangeFill` covers everything else: sliders an imperative runtime
 *   built, uncontrolled inputs, and any controlled one whose call site has not
 *   been given the style prop. It listens rather than polls.
 */

/** The filled fraction of `input`, as a CSS percentage. */
export function rangeFillPercent(min: number, max: number, value: number): string {
  if (![min, max, value].every(Number.isFinite) || max === min) return "0%";
  const fraction = (value - min) / (max - min);
  return `${Math.min(1, Math.max(0, fraction)) * 100}%`;
}

/**
 * Inline style for a controlled range input:
 * `style={rangeFillStyle(value, min, max)}`.
 */
export function rangeFillStyle(value: number, min: number, max: number): CSSProperties {
  return { "--st-fill": rangeFillPercent(min, max, value) } as CSSProperties;
}

function syncElement(input: HTMLInputElement): void {
  // An omitted min/max means the platform defaults of 0 and 100.
  const min = input.min === "" ? 0 : Number(input.min);
  const max = input.max === "" ? 100 : Number(input.max);
  const next = rangeFillPercent(min, max, Number(input.value));
  if (input.style.getPropertyValue("--st-fill") !== next) input.style.setProperty("--st-fill", next);
}

function syncTree(root: ParentNode): void {
  for (const input of root.querySelectorAll<HTMLInputElement>('input[type="range"]')) syncElement(input);
}

/**
 * Keep `--st-fill` current for every range input under `root`. Returns a
 * teardown. Safe to call before any slider exists — the observer picks up
 * whatever a runtime mounts later.
 */
export function installRangeFill(root: HTMLElement): () => void {
  const onInput = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.type === "range") syncElement(target);
  };
  // Capture, so a handler that stops propagation cannot leave a stale fill.
  root.addEventListener("input", onInput, true);
  root.addEventListener("change", onInput, true);

  // Programmatic writes fire no event. Attribute changes and whole subtrees
  // being replaced — which is how the Parity Catalog rebuilds its controls —
  // are both visible here.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target instanceof HTMLInputElement) syncElement(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (node instanceof HTMLInputElement && node.type === "range") syncElement(node);
        else if (node instanceof Element) syncTree(node);
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["value", "min", "max", "step"],
  });

  syncTree(root);
  return () => {
    root.removeEventListener("input", onInput, true);
    root.removeEventListener("change", onInput, true);
    observer.disconnect();
  };
}
