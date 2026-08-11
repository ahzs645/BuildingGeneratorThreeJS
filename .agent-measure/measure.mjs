import puppeteer from "puppeteer-core";

const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844 },
  { name: "844x390", width: 844, height: 390 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--disable-dev-shm-usage"],
});

const report = {};

for (const vp of VIEWPORTS) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.width, height: vp.height, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const logs = [];
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 200)));
  page.on("pageerror", (e) => logs.push(`pageerror: ${String(e).slice(0, 300)}`));
  await page.goto(`${BASE}/crayon`, { waitUntil: "networkidle2", timeout: 90_000 });
  await sleep(1500);

  // Open the mobile overlay.
  const toggle = await page.$(".graph-toggle");
  const out = { hadToggle: Boolean(toggle) };
  if (toggle) await toggle.click();
  await page.waitForSelector(".st-overlay .blender-flow-wrap", { timeout: 30_000 }).catch(() => {});
  await sleep(2500);

  // --- toolbar inventory
  out.toolbar = await page.evaluate(() => {
    const wrap = document.querySelector(".st-overlay");
    if (!wrap) return null;
    return [...wrap.querySelectorAll("header button, .blender-flow-toolbar button, .blender-flow-toolbar select")]
      .map((el) => (el.getAttribute("aria-label") || el.title || el.textContent || el.tagName).trim().slice(0, 30));
  });

  // --- clipped nodes
  out.nodes = await page.evaluate(() => {
    const stage = document.querySelector(".st-overlay .blender-flow-stage");
    if (!stage) return null;
    const box = stage.getBoundingClientRect();
    const cards = [...stage.querySelectorAll(".react-flow__node-blenderNode")];
    let clipped = 0;
    for (const card of cards) {
      const r = card.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) clipped += 1;
    }
    return { rendered: cards.length, clipped, stage: { w: Math.round(box.width), h: Math.round(box.height) } };
  });

  // --- controls overlap a node?
  out.controlsOverlap = await page.evaluate(() => {
    const controls = document.querySelector(".st-overlay .react-flow__controls");
    if (!controls) return null;
    const c = controls.getBoundingClientRect();
    const hits = [...document.querySelectorAll(".st-overlay .react-flow__node-blenderNode")].filter((n) => {
      const r = n.getBoundingClientRect();
      return r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top;
    }).length;
    return { rect: { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.width), h: Math.round(c.height) }, overlappingNodes: hits };
  });

  // --- attribution vs minimap
  out.attribution = await page.evaluate(() => {
    const attr = document.querySelector(".st-overlay .react-flow__attribution");
    const mini = document.querySelector(".st-overlay .annotation-minimap");
    if (!attr) return null;
    const a = attr.getBoundingClientRect();
    const style = getComputedStyle(attr);
    const res = { rect: { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.width), h: Math.round(a.height) }, display: style.display, visibility: style.visibility, overlapMinimap: false };
    if (mini) {
      const m = mini.getBoundingClientRect();
      res.minimap = { x: Math.round(m.x), y: Math.round(m.y), w: Math.round(m.width), h: Math.round(m.height) };
      res.overlapMinimap = a.left < m.right && a.right > m.left && a.top < m.bottom && a.bottom > m.top;
    }
    return res;
  });

  // --- status bar truncation
  out.statusbar = await page.evaluate(() => {
    const bar = document.querySelector(".st-overlay .graph-statusbar");
    if (!bar) return null;
    return {
      spans: [...bar.children].map((s) => ({
        text: s.textContent.trim().slice(0, 60),
        clientWidth: Math.round(s.clientWidth),
        scrollWidth: Math.round(s.scrollWidth),
        truncated: s.scrollWidth > s.clientWidth + 1,
        visible: getComputedStyle(s).display !== "none",
      })),
    };
  });

  // --- search field height
  out.search = await page.evaluate(() => {
    const el = document.querySelector(".st-overlay .graph-search");
    const input = document.querySelector(".st-overlay .graph-search input");
    return {
      wrapper: el ? Math.round(el.getBoundingClientRect().height) : null,
      input: input ? Math.round(input.getBoundingClientRect().height) : null,
    };
  });

  // --- Add affordance present?
  out.addButton = await page.evaluate(() => {
    const btn = document.querySelector(".st-overlay .graph-add-button, .st-overlay [data-add-node]");
    return btn ? { text: btn.textContent.trim(), h: Math.round(btn.getBoundingClientRect().height), w: Math.round(btn.getBoundingClientRect().width) } : null;
  });

  // --- genuine long-press on the pane
  const pane = await page.evaluate(() => {
    const p = document.querySelector(".st-overlay .react-flow__pane");
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.x + r.width * 0.72), y: Math.round(r.y + r.height * 0.22) };
  });
  out.longPressPane = { at: pane, addMenu: false, contextMenu: false };
  if (pane) {
    await page.evaluate(() => {
      window.__ctxEvents = 0;
      document.addEventListener("contextmenu", () => { window.__ctxEvents += 1; }, true);
    });
    await page.touchscreen.touchStart(pane.x, pane.y);
    await sleep(900);
    await page.touchscreen.touchEnd();
    await sleep(500);
    out.longPressPane.addMenu = await page.evaluate(() => Boolean(document.querySelector(".graph-add-menu")));
    out.longPressPane.contextMenu = await page.evaluate(() => Boolean(document.querySelector(".graph-context-menu")));
    out.longPressPane.contextmenuEvents = await page.evaluate(() => window.__ctxEvents);
  }
  // close any menu
  await page.evaluate(() => document.querySelector(".graph-popup header button")?.click());
  await page.keyboard.press("Escape");
  await sleep(200);

  // --- genuine long-press on a node
  const nodePt = await page.evaluate(() => {
    const stage = document.querySelector(".st-overlay .blender-flow-stage");
    if (!stage) return null;
    const box = stage.getBoundingClientRect();
    for (const n of document.querySelectorAll(".st-overlay .react-flow__node-blenderNode")) {
      const r = n.getBoundingClientRect();
      if (r.width < 5) continue;
      const cx = r.x + r.width / 2, cy = r.y + 8;
      if (cx > box.left + 10 && cx < box.right - 10 && cy > box.top + 10 && cy < box.bottom - 10) {
        return { x: Math.round(cx), y: Math.round(cy), id: n.getAttribute("data-id") };
      }
    }
    return null;
  });
  out.longPressNode = { at: nodePt, contextMenu: false };
  if (nodePt) {
    await page.touchscreen.touchStart(nodePt.x, nodePt.y);
    await sleep(900);
    await page.touchscreen.touchEnd();
    await sleep(500);
    out.longPressNode.contextMenu = await page.evaluate(() => Boolean(document.querySelector(".graph-context-menu")));
    out.longPressNode.menuItems = await page.evaluate(() =>
      [...document.querySelectorAll(".graph-context-menu button")].map((b) => b.textContent.trim().slice(0, 24)));
  }

  out.logs = logs.slice(0, 12);
  report[vp.name] = out;
  await page.close();
}

// --- add-menu duplicate audit (desktop, easier to open)
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/crayon`, { waitUntil: "networkidle2", timeout: 90_000 });
  await sleep(3000);
  const pane = await page.evaluate(() => {
    const p = document.querySelector(".react-flow__pane");
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.x + r.width * 0.5), y: Math.round(r.y + r.height * 0.5) };
  });
  if (pane) {
    await page.mouse.click(pane.x, pane.y, { button: "right" });
    await sleep(600);
  }
  report.addMenu = await page.evaluate(() => {
    const menu = document.querySelector(".graph-add-menu");
    if (!menu) return null;
    const rows = [...menu.querySelectorAll("div > button")].map((b) => ({
      label: b.querySelector("b")?.textContent?.trim() ?? "",
      meta: b.querySelector("small")?.textContent?.trim() ?? "",
    }));
    const counts = {};
    for (const r of rows) counts[r.label] = (counts[r.label] ?? 0) + 1;
    return {
      rows: rows.length,
      groups: [...menu.querySelectorAll("[data-template-group], .graph-add-group")].length,
      duplicates: Object.entries(counts).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]),
      sample: rows.slice(0, 8),
    };
  });
  // Shift+A
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.querySelector(".graph-add-menu header button")?.click());
  await sleep(300);
  await page.mouse.move(pane.x, pane.y);
  await page.evaluate(() => document.querySelector(".react-flow__pane")?.focus?.());
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Shift");
  await sleep(500);
  report.shiftA = await page.evaluate(() => Boolean(document.querySelector(".graph-add-menu")));
  await page.close();
}

console.log(JSON.stringify(report, null, 2));
await browser.close();
