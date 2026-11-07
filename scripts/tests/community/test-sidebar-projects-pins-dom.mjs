#!/usr/bin/env node
/*
 * test-sidebar-projects-pins-dom.mjs - headless-Chromium DOM tests for the pinned
 * projects half of the sidebar projects feature (js/sidebar_projects_pins.js,
 * delivered by patches/community/add_feature_sidebar_projects.nim).
 *
 * The sidebar is REMOTE claude.ai markup, so a clean patch run says nothing about
 * this working. The fixture reproduces the structure measured live on 4.23118.0
 * with the diagnostic dump: a [data-testid="sidebar-recents"] column of
 * .df-sortable-section blocks, each holding a .group/section whose
 * .group/labelrow carries a button with data-group-name. The real stylesheet is
 * taken from js/sidebar_projects_main.js (captured through its insertCSS call), so
 * the script and the CSS are tested together: a hidden block really is
 * display:none, and the order really is the visual order.
 *
 * Scenarios run inside ONE page (sequential, shared state, like a real session)
 * and report back as JSON in <pre id="out">, read out of
 * `chromium --headless --dump-dom`. Exit 3 = no chromium on PATH.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";
import { unescapeHtml } from "../lib/unescape-html.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const argv = process.argv.slice(2);
const CHROMIUM = (() => {
  const i = argv.indexOf("--chromium");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  for (const c of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    try {
      const p = execFileSync("/bin/sh", ["-c", "command -v " + c], { encoding: "utf8" }).trim();
      if (p) return p;
    } catch {}
  }
  return null;
})();
if (!CHROMIUM) { console.log("  SKIP: no chromium on PATH"); process.exit(3); }

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); }
  else { fail++; console.log("  FAIL " + n); } };

// --- the real stylesheet, captured from the main-process module ----------------
async function captureCss() {
  const dir = mkdtempSync(join(tmpdir(), "cdb-pins-css-"));
  const inserted = [];
  const page = { id: 1, getURL: () => "https://claude.ai/epitaxy", isDestroyed: () => false,
    insertCSS: async (css) => { inserted.push(css); return "k"; }, removeCSS: async () => {},
    executeJavaScript: async () => null, on: () => {}, sendInputEvent: () => {} };
  const handlers = {};
  const electron = { app: { getPath: () => dir, on: () => {}, whenReady: () => Promise.resolve() },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    webContents: { getAllWebContents: () => [page] } };
  const sandbox = { require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "linux", env: {} }, console, globalThis: {}, setTimeout };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, "js/sender_guard.js"), "utf8"), ctx);
  vm.runInContext(readFileSync(join(ROOT, "js/sidebar_projects_main.js"), "utf8")
    .replace('"__CDB_SIDEBAR_PAGE_SRC__"', '""'), ctx);
  await handlers["cdb-sidebar:pref-set"](
    { sender: { getURL: () => "https://claude.ai/epitaxy", isDestroyed: () => false } }, true);
  await new Promise((r) => setTimeout(r, 0));
  rmSync(dir, { recursive: true, force: true });
  return inserted[0] || "";
}

// --- fixture ------------------------------------------------------------------
function section(id, name) {
  return '<div class="df-sortable-section" id="' + id + '"><div class="group/section flex flex-col gap-px">' +
    '<div class="df-drag-shiftable"><div class="group/labelrow" data-sidebar-group-label>' +
    '<h3><button data-group-name="' + name + '">' + name + '</button></h3></div></div>' +
    '<div class="relative df-drag-shiftable"><div class="group hit-row">session of ' + name + '</div></div>' +
    '</div></div>';
}
// The inside of a section block, for building one later from script.
function sectionInner(name) {
  return section("x", name).replace(/^<div class="df-sortable-section" id="x">/, "").replace(/<\/div>$/, "");
}
const MENU_HTML =
  '<div role="menu" id="menu">' +
  '<div role="menuitem" class="mi" data-highlighted="" id="first-item"><svg width="8" height="8"></svg>' +
  '<span class="lbl">Neue Sitzung</span><span class="kbd">N</span></div>' +
  '<div role="separator"></div>' +
  '<div role="menuitem" class="mi"><span class="lbl">Nach oben verschieben</span></div>' +
  '<div role="menuitem" class="mi"><span class="lbl">Nach unten verschieben</span></div>' +
  '</div>';

function page(css, pinsSrc) {
  const scenario = `
(async function () {
  var KEY = "cdb-sidebar-projects";
  var out = {}, dbg = [];
  console.debug = function (m) { dbg.push(String(m)); };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function el(id) { return document.getElementById(id); }
  function top(x) { return (typeof x === "string" ? el(x) : x).getBoundingClientRect().top; }
  function stored() { return JSON.parse(localStorage.getItem(KEY) || "null"); }
  function anchor() { return document.querySelector('[data-testid="sidebar-recents"]'); }
  function divider() { return anchor().querySelector(":scope > .cdb-pin-divider"); }
  function disp(id) { return getComputedStyle(el(id)).display; }
  async function openMenuOn(name) {
    var old = el("menu"); if (old) old.remove();
    var btn = document.querySelector('[data-group-name="' + name + '"]');
    btn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sleep(120); // upstream renders its menu asynchronously, in a portal
    document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(MENU_HTML)});
    await sleep(300);
    return document.querySelector("[data-cdb-pin-item]");
  }

  localStorage.setItem(KEY, JSON.stringify({ pinned: ["Charlie"], collapsed: false }));
  window.__cdbSidebarPins.start();
  await sleep(300);

  // 1. order and divider
  out.display = getComputedStyle(anchor()).display;
  out.dividerCount = anchor().querySelectorAll(".cdb-pin-divider").length;
  out.orders = ["s-a", "s-b", "s-c", "s-d"].map(function (i) { return el(i).style.order; });
  out.pinnedAttr = ["s-a", "s-b", "s-c", "s-d"].map(function (i) { return el(i).hasAttribute("data-cdb-pinned"); });
  out.visualOrder = ["s-c", "divider", "s-a", "s-b", "s-d"].map(function (i) {
    return i === "divider" ? top(divider()) : top(i); });
  out.count = divider().querySelector(".cdb-pin-count").textContent;
  out.ariaExpanded = divider().getAttribute("aria-expanded");
  out.dividerLabel = divider().getAttribute("aria-label");

  // 2. collapse and expand by clicking the divider
  divider().click(); await sleep(100);
  out.collapsedDisplay = ["s-a", "s-b", "s-c", "s-d"].map(disp);
  out.collapsedAria = divider().getAttribute("aria-expanded");
  out.collapsedStored = stored().collapsed;
  out.collapsedLabel = divider().getAttribute("aria-label");
  divider().click(); await sleep(100);
  out.expandedDisplay = ["s-a", "s-b", "s-c", "s-d"].map(disp);
  out.expandedStored = stored().collapsed;

  // 3. the keyboard works on the divider
  divider().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(100);
  out.enterCollapsed = disp("s-a");
  divider().dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })); await sleep(100);
  out.spaceExpanded = disp("s-a");

  // 4. the menu entry on an unpinned project
  var item = await openMenuOn("Alpha");
  out.itemExists = !!item;
  out.itemText = item && item.textContent;
  out.itemKids = item && item.children.length;
  out.itemHasSvg = !!(item && item.querySelector("svg"));
  out.itemAfterSeparator = !!(item && item.previousElementSibling &&
    item.previousElementSibling.getAttribute("role") === "separator");
  out.itemRole = item && item.getAttribute("role");
  out.itemNoHighlight = item && !item.hasAttribute("data-highlighted");
  out.templateUntouched = el("first-item").textContent.indexOf("Neue Sitzung") >= 0 &&
    !!el("first-item").querySelector("svg");
  item.dispatchEvent(new MouseEvent("mouseenter"));
  out.hoverHighlight = item.hasAttribute("data-highlighted") && !el("first-item").hasAttribute("data-highlighted");
  item.click(); await sleep(150);
  out.pinnedAfterClick = stored().pinned;
  out.closeRequests = dbg.filter(function (m) { return m === "__cdb-sidebar:close-menu"; }).length;
  out.alphaOrder = el("s-a").style.order;
  out.charlieOrder = el("s-c").style.order;

  // 5. the entry on a pinned project says "unpin" and removes the pin
  var item2 = await openMenuOn("Charlie");
  out.pinnedItemText = item2 && item2.textContent;
  item2.click(); await sleep(150);
  out.pinnedAfterUnpin = stored().pinned;
  out.closeRequests2 = dbg.filter(function (m) { return m === "__cdb-sidebar:close-menu"; }).length;

  // 6. a menu that does not belong to a project heading gets no entry
  if (el("menu")) el("menu").remove();
  var session = document.querySelector(".hit-row");
  session.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await sleep(120);
  document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(MENU_HTML)});
  await sleep(300);
  out.noEntryOnSession = !document.querySelector("[data-cdb-pin-item]");
  el("menu").remove();

  // 7. one pinned among others keeps the divider; everything pinned has none
  out.dividerWhenOnePinned = !!divider();
  localStorage.setItem(KEY, JSON.stringify({ pinned: ["Alpha", "Bravo", "Charlie", "Delta"], collapsed: true }));
  window.__cdbSidebarPins.stop(); window.__cdbSidebarPins.start(); await sleep(200);
  out.allPinnedDivider = !!divider();
  out.allPinnedHidden = ["s-a", "s-b", "s-c", "s-d"].map(disp);

  // 8. state survives a restart of the script; a new project is picked up
  localStorage.setItem(KEY, JSON.stringify({ pinned: ["Delta"], collapsed: true }));
  window.__cdbSidebarPins.stop(); window.__cdbSidebarPins.start(); await sleep(200);
  out.restartedHidden = ["s-a", "s-b", "s-c", "s-d"].map(disp);
  var added = document.createElement("div");
  added.className = "df-sortable-section"; added.id = "s-e";
  added.innerHTML = ${JSON.stringify(sectionInner("Echo"))};
  anchor().insertBefore(added, anchor().firstChild);
  await sleep(300);
  out.newSectionOrder = el("s-e").style.order;
  out.newSectionHidden = disp("s-e");
  // upstream replacing our divider must not break the list
  divider().remove(); await sleep(300);
  out.dividerRecreated = !!divider();

  // 9. English page language
  document.documentElement.lang = "en";
  var item3 = await openMenuOn("Echo");
  out.englishText = item3 && item3.textContent;
  el("menu").remove();
  // the page language only changes with a reload, so the script starts afresh
  window.__cdbSidebarPins.stop(); window.__cdbSidebarPins.start(); await sleep(200);
  out.englishDividerLabel = divider().getAttribute("aria-label");

  // 10. stop() restores the page
  window.__cdbSidebarPins.stop(); await sleep(100);
  out.afterStop = {
    divider: !!document.querySelector(".cdb-pin-divider"),
    pinsAttr: anchor().hasAttribute("data-cdb-pins"),
    collapsedAttr: anchor().hasAttribute("data-cdb-collapsed"),
    orders: ["s-a", "s-b", "s-c", "s-d", "s-e"].map(function (i) { return el(i).style.order; }),
    pinnedAttrs: document.querySelectorAll("[data-cdb-pinned]").length,
    display: ["s-a", "s-b", "s-c", "s-d", "s-e"].map(disp),
    anchorDisplay: getComputedStyle(anchor()).display
  };
  // a context menu opened after stop() gets no entry
  var item4 = await openMenuOn("Alpha");
  out.noEntryAfterStop = !item4;
  return out;
})().then(function (o) { document.getElementById("out").textContent = JSON.stringify(o); },
          function (e) { document.getElementById("out").textContent = JSON.stringify({ error: String(e && e.stack || e) }); });
`;
  return '<!doctype html><html lang="de"><head><meta charset="utf-8"><style>' + css +
    '.sr-only{position:absolute;width:1px;height:1px;overflow:hidden}' +
    'body{margin:0;width:260px}.hit-row{height:28px}button{font:inherit}</style></head><body>' +
    '<aside class="dframe-sidebar"><div class="df-session-list"><div class="df-recents-anchor" data-testid="sidebar-recents">' +
    section("s-a", "Alpha") + section("s-b", "Bravo") + section("s-c", "Charlie") + section("s-d", "Delta") +
    '<span class="sr-only">hidden</span></div></div></aside><pre id="out">NOT RUN</pre>' +
    "<script>" + pinsSrc + "</script><script>" + scenario + "</script></body></html>";
}

const css = await captureCss();
ok(/data-cdb-pins/.test(css) && /cdb-pin-divider/.test(css), "the captured stylesheet carries the pinned-projects rules");

const dir = mkdtempSync(join(tmpdir(), "cdb-pins-dom-"));
const file = join(dir, "fixture.html");
writeFileSync(file, page(css, readFileSync(join(ROOT, "js/sidebar_projects_pins.js"), "utf8")));
let dom = "";
try {
  dom = execFileSync(CHROMIUM, ["--headless", "--disable-gpu", "--no-sandbox",
    "--virtual-time-budget=20000", "--dump-dom", "file://" + file],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch (e) { console.log("  FAIL chromium run: " + e.message); process.exit(1); }
rmSync(dir, { recursive: true, force: true });

const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
let r = null;
try { r = JSON.parse(unescapeHtml(m ? m[1] : "")); } catch { r = null; }
if (!r || r.error) {
  console.log("  FAIL scenario did not finish: " + (r ? r.error : (m ? m[1].slice(0, 200) : "no output")));
  process.exit(1);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const asc = (a) => a.every((v, i) => i === 0 || v > a[i - 1]);

// 1
ok(r.display === "flex", "the project column becomes a flex column while the script runs");
ok(r.dividerCount === 1, "exactly one divider");
ok(eq(r.orders, ["1000", "1001", "0", "1002"]), "pinned block gets the lowest order, the rest follow in upstream's order");
ok(eq(r.pinnedAttr, [false, false, true, false]), "only the pinned block carries data-cdb-pinned");
ok(asc(r.visualOrder), "visually: pinned project, then the divider, then the other projects, in order");
ok(r.count === "3", "the divider counts the projects it hides");
ok(r.ariaExpanded === "true" && /\(3\)/.test(r.dividerLabel), "the divider is expanded and labelled with the count");
// 2
ok(eq(r.collapsedDisplay, ["none", "none", "block", "none"]), "clicking the divider hides every project that is not pinned");
ok(r.collapsedAria === "false" && r.collapsedStored === true, "collapsed state is announced and stored");
ok(/einblenden/.test(r.collapsedLabel), "the collapsed divider offers to show the projects again");
ok(eq(r.expandedDisplay, ["block", "block", "block", "block"]) && r.expandedStored === false,
   "clicking again shows them again");
// 3
ok(r.enterCollapsed === "none" && r.spaceExpanded === "block", "Enter and Space work on the divider");
// 4
ok(r.itemExists && r.itemRole === "menuitem", "right-click on a project heading adds a menu item");
ok(r.itemText === "Anpinnen", "an unpinned project offers \"Anpinnen\" on a German page");
ok(r.itemKids === 1 && r.itemHasSvg === false, "the clone keeps only the label: no icon, no shortcut hint");
ok(r.itemAfterSeparator, "the entry sits right after the first separator");
ok(r.itemNoHighlight && r.hoverHighlight, "hovering highlights the entry and clears upstream's own highlight");
ok(r.templateUntouched, "the menu item it was cloned from is left alone");
ok(eq(r.pinnedAfterClick, ["Charlie", "Alpha"]), "clicking the entry pins the project");
ok(r.closeRequests === 1, "after the click the page asks the main process to close the menu, once");
ok(r.alphaOrder === "0" && r.charlieOrder === "1", "pinned projects keep upstream's relative order, not the order they were pinned in");
// 5
ok(r.pinnedItemText === "Anpinnen aufheben", "a pinned project offers \"Anpinnen aufheben\"");
ok(eq(r.pinnedAfterUnpin, ["Alpha"]) && r.closeRequests2 === 2, "clicking it unpins the project and closes the menu");
// 6
ok(r.noEntryOnSession, "a context menu on a session row gets no pin entry");
// 7
ok(r.dividerWhenOnePinned === true, "one pinned project among others keeps the divider");
ok(r.allPinnedDivider === false, "with every project pinned there is no divider");
ok(eq(r.allPinnedHidden, ["block", "block", "block", "block"]), "with every project pinned nothing is hidden, even if collapsed was stored");
// 8
ok(eq(r.restartedHidden, ["none", "none", "none", "block"]), "state read back after a restart: only the pinned project stays visible");
ok(r.newSectionOrder.length > 0 && r.newSectionHidden === "none", "a project added later is picked up and follows the same rules");
ok(r.dividerRecreated, "a divider removed by upstream's re-render is recreated");
// 9
ok(r.englishText === "Pin", "an English page gets \"Pin\"");
ok(/hide|show/i.test(r.englishDividerLabel), "the divider label is English on an English page");
// 10
ok(r.afterStop.divider === false && r.afterStop.pinsAttr === false && r.afterStop.collapsedAttr === false,
   "stop() removes the divider and the attributes");
ok(eq(r.afterStop.orders, ["", "", "", "", ""]) && r.afterStop.pinnedAttrs === 0,
   "stop() clears every order and pinned mark");
ok(eq(r.afterStop.display, ["block", "block", "block", "block", "block"]), "stop() shows every project again");
ok(r.afterStop.anchorDisplay !== "flex", "stop() gives the project column back to upstream's layout");
ok(r.noEntryAfterStop, "no menu entry after stop()");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
