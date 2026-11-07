/*
 * sidebar_projects_main.js - main-process half of the sidebar projects feature.
 *
 * Makes the sidebar's project / session hierarchy readable: project headings
 * larger and in the accent colour, the sessions under a project indented. It is
 * pure CSS, inserted into the claude.ai page with webContents.insertCSS and
 * removed again with removeCSS, so the Settings -> Extra switch applies live and
 * no page script is involved. The selectors lean on upstream's own hooks (the
 * `group/section` and `group/labelrow` classes, the --df-group-font variable),
 * measured on 4.23118.0 with the diagnostic dump below.
 *
 * DIAGNOSTIC (CLAUDE_SIDEBAR_DUMP=1): additionally injects the page script
 * (js/sidebar_projects_page.js) and polls its dump() every few seconds, writing
 * a text-free structural snapshot of the sidebar to
 *   <userData>/sidebar-projects-dump-<webContentsId>.json
 * so the selectors can be re-derived after an upstream redesign.
 *
 * SECURITY: the caller of the IPC pair is remote claude.ai code. Every handler
 * validates the sender's origin (js/sender_guard.js) and takes only a boolean;
 * nothing page-supplied reaches the filesystem.
 */
;/*__CDB_SIDEBAR_PROJECTS__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  if (globalThis.__cdbSidebarProjectsMain) return;
  globalThis.__cdbSidebarProjectsMain = true;

  var _electron = require("electron");
  var _app = _electron.app;
  var _ipc = _electron.ipcMain;
  var _fs = require("fs");
  var _path = require("path");
  var _URL = require("url").URL;

  var PAGE_SRC = "__CDB_SIDEBAR_PAGE_SRC__";
  var PREF_KEY = "sidebarProjects";
  var PREF_DEFAULT = false;
  var JSONC_NAME = "claude-desktop-extra.jsonc";
  var JSON_NAME = "claude-desktop-extra.json";
  var DUMP = process.env.CLAUDE_SIDEBAR_DUMP === "1";

  // The stylesheet. Project headings: --df-group-font is the variable upstream's
  // label row reads for its font size. The colour is set on the heading button
  // AND its spans, because upstream colours inner spans with their own classes;
  // the hover rule keeps a visible hover state that the colour rule would
  // otherwise hide. Sessions: the row wrappers (.relative.df-drag-shiftable)
  // inside a section are shifted in, so the hover highlight starts indented too.
  // The pinned section shares the section/label classes and gets the heading
  // style; its rows are a different element and stay where they are.
  var CSS =
    ".dframe-sidebar .df-session-list [class~=\"group/labelrow\"]{" +
      "--df-group-font:16px;font-weight:650}" +
    ".dframe-sidebar .df-session-list [class~=\"group/labelrow\"] h3 button," +
    ".dframe-sidebar .df-session-list [class~=\"group/labelrow\"] h3 button span{" +
      "color:var(--cds-fill-accent,#e0a85a)}" +
    ".dframe-sidebar .df-session-list [class~=\"group/labelrow\"] h3 button:hover," +
    ".dframe-sidebar .df-session-list [class~=\"group/labelrow\"] h3 button:hover span{" +
      "color:var(--cds-text-primary,currentColor)}" +
    ".dframe-sidebar .df-session-list [class~=\"group/section\"] .relative.df-drag-shiftable{" +
      "margin-inline-start:14px}";

  // __cdbDiag (claude-patches.log) is defined inside upstream's app "ready"
  // handler, which runs after this IIFE, and console.log is discarded by the
  // official build. So a line logged before the sink exists is queued and
  // flushed one tick after "ready"; console.log stays the last resort.
  var logQueue = [];
  function emitLog(line) {
    try { (globalThis.__cdbDiag || console.log)(line); } catch (e) {}
  }
  function flushLog() {
    var q = logQueue;
    logQueue = null;
    for (var i = 0; q && i < q.length; i++) emitLog(q[i]);
  }
  function log(m) {
    var line = "[sidebar-projects] " + m;
    if (logQueue && typeof globalThis.__cdbDiag !== "function") { logQueue.push(line); return; }
    flushLog();
    emitLog(line);
  }
  try { _app.whenReady().then(function () { setTimeout(flushLog, 0); }, function () {}); }
  catch (e) { setTimeout(flushLog, 0); }

  function userDir() {
    try { return _app.getPath("userData"); } catch (e) { return null; }
  }
  // Same as every other config consumer: the one-time claude-desktop-bin.* ->
  // claude-desktop-extra.* rename migration is installed by the custom-themes
  // patch and may not have run yet, so nudge it before every path resolution.
  function pathFor(name) {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    var d = userDir();
    return d ? _path.join(d, name) : null;
  }

  // Comment/trailing-comma stripper for the .jsonc/.json config files. Whole
  // quoted strings are matched FIRST and passed through untouched, so a string
  // value containing "//" is never truncated.
  function stripComments(s) {
    return String(s)
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, function (m, q) { return q ? q : ""; })
      .replace(/,(\s*[}\]])/g, "$1");
  }
  // LENIENT reader for the read-only paths: any problem is "no pref set here".
  function readFileJson(p) {
    try {
      if (!p || !_fs.existsSync(p)) return null;
      var stripped = stripComments(_fs.readFileSync(p, "utf8"));
      var v = stripped.trim() ? JSON.parse(stripped) : {};
      return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
    } catch (e) { return null; }
  }

  // The .jsonc is the HUMAN-OWNED file and wins the startup merge, so a value
  // found there is reported as locked and pref-set refuses to fight it.
  function readPrefFromDisk() {
    var jsonc = readFileJson(pathFor(JSONC_NAME));
    if (jsonc && typeof jsonc[PREF_KEY] === "boolean") {
      return { value: jsonc[PREF_KEY], source: "jsonc-locked" };
    }
    var json = readFileJson(pathFor(JSON_NAME));
    if (json && typeof json[PREF_KEY] === "boolean") {
      return { value: json[PREF_KEY], source: "json" };
    }
    return { value: PREF_DEFAULT, source: "default" };
  }

  // Writes ONLY the .json, tmp + rename, and every other key survives. An
  // existing-but-broken file is NOT treated as empty (that would silently drop
  // every other extra's settings): only ENOENT proceeds with an empty object.
  function writePref(value) {
    var p = pathFor(JSON_NAME);
    if (!p) return { ok: false, error: "no userData path" };
    var raw = null;
    try { raw = _fs.readFileSync(p, "utf8"); }
    catch (e) {
      if (e.code !== "ENOENT") return { ok: false, error: "cannot read " + p + ": " + ((e && e.message) || String(e)) };
    }
    var cfg = {};
    if (raw !== null) {
      var stripped = stripComments(raw);
      try { cfg = stripped.trim() ? JSON.parse(stripped) : {}; }
      catch (e2) {
        return { ok: false, error: p + " is not valid JSON (" + e2.message +
          ") - fix or remove it first; nothing was written" };
      }
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        return { ok: false, error: p + " must contain a JSON object; nothing was written" };
      }
      if (stripped !== raw) {
        // Rewriting as plain JSON drops comments - keep the original once.
        try { _fs.writeFileSync(p + ".cdb-bak", raw, { flag: "wx" }); } catch (e3) {}
      }
    }
    // The default is FALSE, so "off" is the ABSENCE of the key.
    if (value === PREF_DEFAULT) delete cfg[PREF_KEY];
    else cfg[PREF_KEY] = value;
    var tmp = p + ".cdb-tmp";
    try {
      _fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      _fs.renameSync(tmp, p);
    } catch (e4) {
      try { _fs.unlinkSync(tmp); } catch (e5) {}
      return { ok: false, error: "cannot write " + p + ": " + ((e4 && e4.message) || String(e4)) };
    }
    return { ok: true, path: p };
  }

  // The IPC sender validator is shared: js/sender_guard.js. Looked up at call
  // time; a missing guard fails closed.
  function okSender(ev) { var g = globalThis.__cdbSenderGuard; return !!g && g.okSender(ev); }

  // The URL test only decides whether to bother touching this webContents, it is
  // NOT a security boundary (the stylesheet is static and the IPC handlers
  // re-validate the sender strictly). Any claude.ai/claude.com subdomain gets
  // it, so an upstream move to another subdomain does not kill the feature;
  // app://localhost (exact, no port) is the main window in 3P mode.
  function injectHost(rawUrl) {
    var u;
    try { u = new _URL(String(rawUrl)); } catch (e) { return false; }
    if (u.protocol === "app:" && u.host === "localhost") return true;
    var host = u.hostname;
    return host === "claude.ai" || host.endsWith(".claude.ai") ||
      host === "claude.com" || host.endsWith(".claude.com");
  }

  // ---- the stylesheet, applied and removed live -------------------------------
  var cssKeys = {};
  function applyCss(wc) {
    try {
      if (wc.isDestroyed() || !injectHost(wc.getURL())) return;
      wc.insertCSS(CSS).then(function (key) { cssKeys[wc.id] = key; }, function () {});
    } catch (e) {}
  }
  function removeCss(wc) {
    try {
      var key = cssKeys[wc.id];
      delete cssKeys[wc.id];
      if (key && !wc.isDestroyed()) wc.removeCSS(key).catch(function () {});
    } catch (e) {}
  }
  function eachPage(fn) {
    try { _electron.webContents.getAllWebContents().forEach(fn); } catch (e) {}
  }

  _ipc.handle("cdb-sidebar:pref-read", function (ev) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    var disk = readPrefFromDisk();
    return { ok: true, enabled: disk.value === true,
      lockedByJsonc: disk.source === "jsonc-locked", source: disk.source };
  });

  _ipc.handle("cdb-sidebar:pref-set", function (ev, enabled) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    var disk = readPrefFromDisk();
    if (disk.source === "jsonc-locked") {
      return { ok: false, error: PREF_KEY + " is set in " + JSONC_NAME +
        " - edit that file to change it" };
    }
    var w = writePref(enabled);
    if (!w.ok) return w;
    eachPage(enabled ? applyCss : removeCss);
    return { ok: true, enabled: enabled, path: w.path };
  });

  // ---- diagnostic dump (CLAUDE_SIDEBAR_DUMP=1) --------------------------------
  var DUMP_POLL_MS = 5000;
  var DUMP_POLL_TRIES = 36; // 3 minutes: time to expand and collapse a project
  function writeDump(wc, payload) {
    var p = _path.join(_app.getPath("userData"), "sidebar-projects-dump-" + wc.id + ".json");
    var tmp = p + ".tmp";
    _fs.writeFileSync(tmp, JSON.stringify(payload, null, 1) + "\n", "utf8");
    _fs.renameSync(tmp, p);
  }
  function pollDump(wc) {
    var last = "", tries = 0;
    function tick() {
      if (wc.isDestroyed() || ++tries > DUMP_POLL_TRIES) return;
      wc.executeJavaScript(
        "window.__cdbSidebarProjects ? window.__cdbSidebarProjects.dump() : null"
      ).then(function (res) {
        if (res && res.nodeCount > 0) {
          var json = JSON.stringify(res);
          if (json !== last) { last = json; writeDump(wc, res); }
        }
      }).catch(function (e) {
        try { writeDump(wc, { error: (e && e.message) || String(e) }); } catch (e2) {}
      }).then(function () { setTimeout(tick, DUMP_POLL_MS); });
    }
    tick();
  }

  _app.on("web-contents-created", function (_ev, wc) {
    wc.on("dom-ready", function () {
      try {
        if (!injectHost((wc.getURL && wc.getURL()) || "")) return;
        if (readPrefFromDisk().value === true) applyCss(wc);
        if (DUMP) wc.executeJavaScript(PAGE_SRC).then(function () { pollDump(wc); }, function () {});
      } catch (e) {}
    });
  });

  setTimeout(function () {
    var disk = readPrefFromDisk();
    log("installed (main); pref " + PREF_KEY + "=" + disk.value + " (source: " + disk.source + ")" +
      (disk.value ? "" : " - opt-in feature is off: sidebar untouched") +
      (DUMP ? "; diagnostic dump on" : ""));
  }, 0);
})();
