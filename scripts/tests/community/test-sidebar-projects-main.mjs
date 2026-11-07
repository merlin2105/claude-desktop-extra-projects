#!/usr/bin/env node
/*
 * test-sidebar-projects-main.mjs - the main-process half of the sidebar projects
 * feature. A clean patch run says nothing about WHEN the stylesheet is applied,
 * whether the switch removes it again, or which pages it reaches, so this suite
 * runs the real module with electron shimmed (fake webContents that record
 * insertCSS / removeCSS) and a temporary profile dir. Exit 3 = a required tool
 * is missing.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); }
  else { fail++; console.log("  FAIL " + n); } };

// A fake webContents: records the CSS it was given and the keys it was told to
// drop, and lets the test fire dom-ready.
function fakePage(id, url) {
  const listeners = {};
  const page = {
    id, inserted: [], removed: [], executed: [], sent: [],
    getURL: () => url, isDestroyed: () => false,
    insertCSS: async (css) => { page.inserted.push(css); return "key-" + id + "-" + page.inserted.length; },
    removeCSS: async (key) => { page.removed.push(key); },
    executeJavaScript: async (src) => { page.executed.push(src); return null; },
    sendInputEvent: (e) => { page.sent.push(e); },
    on: (ev, fn) => { listeners[ev] = fn; },
    fire: (ev, ...args) => listeners[ev] && listeners[ev](...args)
  };
  return page;
}

// platform / env are parameters so the non-Linux and dump-env paths are testable.
// app.on listeners of the LAST load(), so web-contents-created can be driven.
let appListeners = {};
function load(profileDir, pages, { platform = "linux", env = {} } = {}) {
  const handlers = {};
  appListeners = {};
  const electron = {
    app: {
      getPath: () => profileDir,
      on: (ev, fn) => { (appListeners[ev] = appListeners[ev] || []).push(fn); },
      whenReady: () => Promise.resolve()
    },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    webContents: { getAllWebContents: () => pages }
  };
  // The patch embeds both page scripts as one string; do the same here.
  const pageSrc = readFileSync(join(ROOT, "js/sidebar_projects_page.js"), "utf8") + "\n;\n" +
    readFileSync(join(ROOT, "js/sidebar_projects_pins.js"), "utf8");
  const src = readFileSync(join(ROOT, "js/sidebar_projects_main.js"), "utf8")
    .replace('"__CDB_SIDEBAR_PAGE_SRC__"', () => JSON.stringify(pageSrc));
  const sandbox = { require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform, env }, console, globalThis: {}, setTimeout };
  sandbox.globalThis = sandbox;
  { const __c = vm.createContext(sandbox);
    vm.runInContext(readFileSync(new URL("../../../js/sender_guard.js", import.meta.url), "utf8"), __c);
    vm.runInContext(src, __c); }
  return handlers;
}

function sender(url) { return { sender: { getURL: () => url, isDestroyed: () => false } }; }
const okSenderEv = sender("https://claude.ai/epitaxy");
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- the stylesheet itself --------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-sidebar-main-"));
  const page = fakePage(1, "https://claude.ai/epitaxy");
  const h = load(dir, [page]);
  await h["cdb-sidebar:pref-set"](okSenderEv, true);
  await tick();
  const css = page.inserted[0] || "";
  ok(/--df-group-font:\s*16px/.test(css), "stylesheet enlarges the project heading through upstream's --df-group-font");
  ok(/group\/labelrow/.test(css) && /group\/section/.test(css),
     "stylesheet targets upstream's group/labelrow and group/section classes");
  ok(/margin-inline-start:\s*14px/.test(css), "stylesheet indents the session rows");
  ok(/\.dframe-sidebar \.df-session-list/.test(css), "every rule is scoped to the sidebar's session list");
  rmSync(dir, { recursive: true, force: true });
}

// ---- pref round trip and live apply / remove --------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-sidebar-main-"));
  const claude = fakePage(1, "https://claude.ai/epitaxy");
  const other = fakePage(2, "https://example.com/");
  const h = load(dir, [claude, other]);
  ok(typeof h["cdb-sidebar:pref-read"] === "function", "registers cdb-sidebar:pref-read");
  ok(typeof h["cdb-sidebar:pref-set"] === "function", "registers cdb-sidebar:pref-set");

  const initial = await h["cdb-sidebar:pref-read"](okSenderEv);
  ok(initial.ok === true && initial.enabled === false, "pref defaults to off (opt-in)");

  const on = await h["cdb-sidebar:pref-set"](okSenderEv, true);
  await tick();
  ok(on.ok === true && on.enabled === true, "pref-set turns the feature on");
  ok(claude.inserted.length === 1, "turning it on inserts the stylesheet into the claude.ai page live");
  ok(other.inserted.length === 0, "a page outside claude.ai/claude.com is never touched");

  const onDisk = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));
  ok(onDisk.sidebarProjects === true, "pref-set wrote claude-desktop-extra.json");
  const after = await h["cdb-sidebar:pref-read"](okSenderEv);
  ok(after.enabled === true, "pref survives a re-read from disk");

  const off = await h["cdb-sidebar:pref-set"](okSenderEv, false);
  await tick();
  ok(off.ok === true && off.enabled === false, "pref-set(false) turns the feature back off");
  ok(claude.removed.length === 1 && claude.removed[0] === "key-1-1",
     "turning it off removes exactly the stylesheet it inserted");
  const offDisk = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));
  ok(!("sidebarProjects" in offDisk), "setting back to the default removes the key rather than writing false");

  const bad = await h["cdb-sidebar:pref-set"](okSenderEv, "yes");
  ok(bad.ok === false, "pref-set rejects a non-boolean");
  rmSync(dir, { recursive: true, force: true });
}

// ---- dom-ready: applied only while the pref is on ---------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-sidebar-main-"));
  const h = load(dir, []);
  const created = appListeners["web-contents-created"][0];

  const offPage = fakePage(3, "https://claude.ai/epitaxy");
  created({}, offPage); offPage.fire("dom-ready"); await tick();
  ok(offPage.inserted.length === 0, "dom-ready with the pref off leaves the page untouched (upstream behaviour preserved)");

  await h["cdb-sidebar:pref-set"](okSenderEv, true);
  const onPage = fakePage(4, "https://claude.ai/epitaxy");
  created({}, onPage); onPage.fire("dom-ready"); await tick();
  ok(onPage.inserted.length === 1, "dom-ready with the pref on inserts the stylesheet (survives a reload)");

  const foreign = fakePage(5, "https://evil.example/?next=claude.ai");
  created({}, foreign); foreign.fire("dom-ready"); await tick();
  ok(foreign.inserted.length === 0, "a URL that merely contains \"claude.ai\" is not treated as claude.ai");
  ok(offPage.executed.length === 0, "no page script is injected while the pref is off and no dump is requested");
  ok(onPage.executed.some((s) => /__cdbSidebarPins\.start\(\)/.test(s)),
     "with the pref on, dom-ready injects the pinned-projects script and starts it");
  ok(onPage.executed.some((s) => /window\.__cdbSidebarPins = /.test(s)),
     "the injected source carries the pinned-projects module");
  rmSync(dir, { recursive: true, force: true });
}

// ---- pinned projects follow the switch live ---------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-sidebar-main-"));
  const page = fakePage(7, "https://claude.ai/epitaxy");
  const other = fakePage(8, "https://example.com/");
  const h = load(dir, [page, other]);
  await h["cdb-sidebar:pref-set"](okSenderEv, true);
  await tick();
  ok(page.executed.some((s) => /__cdbSidebarPins\.start\(\)/.test(s)), "turning the switch on starts the pin script live");
  await h["cdb-sidebar:pref-set"](okSenderEv, false);
  await tick();
  ok(page.executed.some((s) => s.trim() === "window.__cdbSidebarPins && window.__cdbSidebarPins.stop()"),
     "turning the switch off stops the pin script live");
  ok(other.executed.length === 0, "a page outside claude.ai never gets the script, on or off");
  rmSync(dir, { recursive: true, force: true });
}

// ---- the context-menu close channel -----------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-sidebar-main-"));
  const h = load(dir, []);
  const created = appListeners["web-contents-created"][0];
  const page = fakePage(9, "https://claude.ai/epitaxy");
  created({}, page);
  page.fire("console-message", { message: "__cdb-sidebar:close-menu", level: 0 });
  ok(page.sent.length === 0, "the close request is ignored while the pref is off");

  await h["cdb-sidebar:pref-set"](okSenderEv, true);
  page.fire("console-message", { message: "something else", level: 0 });
  ok(page.sent.length === 0, "any other console message does nothing");
  page.fire("console-message", { message: "__cdb-sidebar:close-menu", level: 0 });
  ok(page.sent.length === 2 && page.sent[0].type === "keyDown" && page.sent[0].keyCode === "Escape" &&
     page.sent[1].type === "keyUp", "the close request sends a real Escape key down and up");
  page.fire("console-message", { message: "__cdb-sidebar:close-menu", level: 0 });
  ok(page.sent.length === 2, "a second request within 200 ms is dropped (rate limit)");

  await new Promise((r) => setTimeout(r, 230));
  const legacy = fakePage(10, "https://claude.ai/epitaxy");
  created({}, legacy);
  legacy.fire("console-message", {}, 0, "__cdb-sidebar:close-menu", 1, "src");
  ok(legacy.sent.length === 2, "the legacy (event, level, message) signature is understood too");

  await new Promise((r) => setTimeout(r, 230));
  const foreign = fakePage(11, "https://evil.example/");
  created({}, foreign);
  foreign.fire("console-message", { message: "__cdb-sidebar:close-menu", level: 0 });
  ok(foreign.sent.length === 0, "a page outside claude.ai cannot request the key press");
  rmSync(dir, { recursive: true, force: true });
}

// ---- .jsonc lock ------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-sidebar-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"),
    '{\n  // locked by the operator\n  "sidebarProjects": false\n}\n');
  const jsonPath = join(dir, "claude-desktop-extra.json");
  const untouched = '{\n  "someOtherExtra": "leave me alone"\n}\n';
  writeFileSync(jsonPath, untouched);
  const h = load(dir, []);
  const read = await h["cdb-sidebar:pref-read"](okSenderEv);
  ok(read.lockedByJsonc === true, "a .jsonc value reports lockedByJsonc");
  const set = await h["cdb-sidebar:pref-set"](okSenderEv, true);
  ok(set.ok === false && /claude-desktop-extra\.jsonc/.test(set.error),
     "pref-set refuses while the .jsonc holds the key");
  ok(readFileSync(jsonPath, "utf8") === untouched, "a refused pref-set does not touch the .json at all");
  rmSync(dir, { recursive: true, force: true });
}

// ---- a broken .json is never overwritten ------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-sidebar-main-"));
  const jsonPath = join(dir, "claude-desktop-extra.json");
  writeFileSync(jsonPath, '{ "other": 1, ');
  const h = load(dir, []);
  const set = await h["cdb-sidebar:pref-set"](okSenderEv, true);
  ok(set.ok === false && /not valid JSON/.test(set.error), "pref-set refuses to write over a broken .json");
  ok(readFileSync(jsonPath, "utf8") === '{ "other": 1, ', "the broken .json is left byte-for-byte as it was");
  rmSync(dir, { recursive: true, force: true });
}

// ---- sender checks ----------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-sidebar-main-"));
  const h = load(dir, []);
  const evil = await h["cdb-sidebar:pref-set"](sender("https://evil.example"), true);
  ok(evil.ok === false && /sender/.test(evil.error), "rejects an unrecognised sender");
  const sub = await h["cdb-sidebar:pref-set"](sender("https://evil.example/?next=claude.ai"), true);
  ok(sub.ok === false, "rejects a sender whose URL merely contains \"claude.ai\" as a substring");
  rmSync(dir, { recursive: true, force: true });
}

// ---- platform and diagnostic gates ------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-sidebar-main-"));
  const win = load(dir, [], { platform: "win32" });
  ok(Object.keys(win).length === 0, "does nothing off Linux");

  const page = fakePage(6, "https://claude.ai/epitaxy");
  load(dir, [page], { env: { CLAUDE_SIDEBAR_DUMP: "1" } });
  const created = appListeners["web-contents-created"][0];
  created({}, page); page.fire("dom-ready"); await tick();
  ok(page.executed.length >= 1, "CLAUDE_SIDEBAR_DUMP=1 injects the diagnostic page script");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
