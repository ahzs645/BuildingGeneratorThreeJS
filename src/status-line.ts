/**
 * The status line of a studio tool: one `.st-state` element holding a
 * `.st-dot` and a `[data-status-text]` message.
 *
 * Tone and message move together on purpose. When they were set separately,
 * four tools ended up rendering a green "ready" sentence beside a dot that had
 * been hardcoded to amber at mount and never touched again — and two of them
 * compensated by recolouring the text, which the kit forbids precisely because
 * it is a second, competing status affordance.
 */

const TONES = ["ready", "busy", "warn", "error"] as const;

/** Matches StudioTone in src/react/studio/StudioChrome.tsx. */
export type StatusTone = (typeof TONES)[number] | "idle";

export type StatusLine = (tone: StatusTone, message: string) => void;

/**
 * Bind the `.st-state` line at `selector`. Returns a setter that applies the
 * tone to the line (so the dot follows) and writes the message into the
 * line's `[data-status-text]` span.
 */
export function bindStatusLine(selector: string, root: ParentNode = document): StatusLine {
  const line = root.querySelector<HTMLElement>(selector);
  if (!line) throw new Error(`Status line not found: ${selector}`);
  const text = line.querySelector<HTMLElement>("[data-status-text]") ?? line;
  return (tone, message) => {
    line.classList.remove(...TONES);
    if (tone !== "idle") line.classList.add(tone);
    text.textContent = message;
  };
}
