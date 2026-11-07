/*
 * sidebar_projects_pins.js - page half of the sidebar projects feature: pinned
 * projects. Injected into the claude.ai page by js/sidebar_projects_main.js,
 * started with __cdbSidebarPins.start() while the Settings -> Extra switch is on
 * and stopped with stop() when it goes off, so the switch applies live.
 *
 *  - Right-click a project heading: the context menu gets one more entry,
 *    "Pin" / "Unpin" (German when the page language is German).
 *  - Pinned projects are listed first, in upstream's own order, and a coloured
 *    divider separates them from the rest. Clicking the divider hides or shows
 *    everything below it, like a project's own fold.
 *
 * NO REACT-OWNED NODE IS MOVED. The project list is a column of
 * `.df-sortable-section` blocks inside [data-testid="sidebar-recents"]; the
 * stylesheet (js/sidebar_projects_main.js) makes that column a flex container
 * and this script only sets `order` and a data attribute on each block, plus one
 * divider element of its own. Upstream's own "move up / down" and drag sorting
 * keep working on the underlying order; pinned projects just float above it.
 *
 * A project is identified by the `data-group-name` attribute upstream puts on its
 * heading (the heading text as a fallback). State lives in this page's
 * localStorage under STORE_KEY: { pinned: [name, ...], collapsed: bool }.
 *
 * The context-menu entry is a clone of one of the menu's own items, so it takes
 * the menu's look without any copied class names, and it is inserted after the
 * first separator. The clone is a plain DOM node React has never seen, so none
 * of upstream's handlers can fire on it. A page cannot close upstream's menu
 * (synthetic Escape / outside clicks are ignored), so after the click this asks
 * the main process for a real Escape through the console channel CLOSE_MSG.
 */
(function () {
  "use strict";
  if (window.__cdbSidebarPins) return;

  var STORE_KEY = "cdb-sidebar-projects";
  var ANCHOR_SEL = '[data-testid="sidebar-recents"]';
  var SECTION_SEL = ".df-sortable-section";
  var CLOSE_MSG = "__cdb-sidebar:close-menu";
  var MAX_PINNED = 500;
  var DIVIDER_ORDER = 500;
  var OTHER_ORDER_BASE = 1000;

  var state = { pinned: [], collapsed: false };
  var running = false;
  var observer = null;
  var observedRoot = null;
  var applyTimer = 0;
  var watchTimer = 0;
  var pending = null; // { key, at }: the project a context menu was just opened on

  var TEXT = {
    de: { pin: "Anpinnen", unpin: "Anpinnen aufheben",
          show: "Weitere Projekte einblenden", hide: "Weitere Projekte ausblenden" },
    en: { pin: "Pin", unpin: "Unpin",
          show: "Show other projects", hide: "Hide other projects" }
  };
  function t(name) {
    var lang = String(document.documentElement.lang || navigator.language || "").toLowerCase();
    return (lang.indexOf("de") === 0 ? TEXT.de : TEXT.en)[name];
  }

  // ---- state ------------------------------------------------------------------
  function load() {
    var v = null;
    try { v = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) {}
    var pinned = [];
    if (v && Array.isArray(v.pinned)) {
      for (var i = 0; i < v.pinned.length && pinned.length < MAX_PINNED; i++) {
        if (typeof v.pinned[i] === "string" && v.pinned[i] && pinned.indexOf(v.pinned[i]) < 0) {
          pinned.push(v.pinned[i]);
        }
      }
    }
    state = { pinned: pinned, collapsed: !!(v && v.collapsed === true) };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function isPinned(key) { return !!key && state.pinned.indexOf(key) >= 0; }
  function togglePin(key) {
    var i = state.pinned.indexOf(key);
    if (i >= 0) state.pinned.splice(i, 1);
    else if (state.pinned.length < MAX_PINNED) state.pinned.push(key);
    save();
    apply();
  }
  function toggleCollapsed() {
    state.collapsed = !state.collapsed;
    save();
    apply();
  }

  // ---- the project list -------------------------------------------------------
  function keyOf(section) {
    var el = section.querySelector("[data-group-name]");
    var v = el && el.getAttribute("data-group-name");
    if (v) return v;
    var lab = section.querySelector("[data-sidebar-group-label]");
    return lab ? lab.textContent.trim() : "";
  }

  function makeDivider(anchor) {
    var d = document.createElement("div");
    d.className = "cdb-pin-divider";
    d.setAttribute("role", "button");
    d.tabIndex = 0;
    d.style.order = String(DIVIDER_ORDER);
    var chev = document.createElement("span");
    chev.className = "cdb-pin-chevron";
    chev.textContent = "▾";
    var line = document.createElement("span");
    line.className = "cdb-pin-line";
    var count = document.createElement("span");
    count.className = "cdb-pin-count";
    d.appendChild(chev);
    d.appendChild(line);
    d.appendChild(count);
    d.addEventListener("click", toggleCollapsed);
    d.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleCollapsed(); }
    });
    anchor.appendChild(d);
    return d;
  }

  function clearAnchor(anchor) {
    anchor.removeAttribute("data-cdb-pins");
    anchor.removeAttribute("data-cdb-collapsed");
    var d = anchor.querySelector(":scope > .cdb-pin-divider");
    if (d) d.remove();
    var kids = anchor.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].removeAttribute("data-cdb-pinned");
      if (kids[i].style && kids[i].style.order) kids[i].style.order = "";
    }
  }

  function applyAnchor(anchor) {
    var sections = [], i;
    for (i = 0; i < anchor.children.length; i++) {
      if (anchor.children[i].matches(SECTION_SEL)) sections.push(anchor.children[i]);
    }
    if (!sections.length) { clearAnchor(anchor); return; }
    var pinned = 0, others = 0;
    for (i = 0; i < sections.length; i++) {
      var on = isPinned(keyOf(sections[i]));
      if (on) {
        sections[i].setAttribute("data-cdb-pinned", "");
        sections[i].style.order = String(pinned++);
      } else {
        sections[i].removeAttribute("data-cdb-pinned");
        sections[i].style.order = String(OTHER_ORDER_BASE + others++);
      }
    }
    anchor.setAttribute("data-cdb-pins", "");
    var divider = anchor.querySelector(":scope > .cdb-pin-divider");
    if (pinned > 0 && others > 0) {
      if (!divider) divider = makeDivider(anchor);
      divider.setAttribute("aria-expanded", String(!state.collapsed));
      divider.setAttribute("aria-label", t(state.collapsed ? "show" : "hide") + " (" + others + ")");
      divider.querySelector(".cdb-pin-count").textContent = String(others);
      if (state.collapsed) anchor.setAttribute("data-cdb-collapsed", "");
      else anchor.removeAttribute("data-cdb-collapsed");
    } else {
      if (divider) divider.remove();
      anchor.removeAttribute("data-cdb-collapsed");
    }
  }

  // Our own DOM writes would re-trigger the observer, so it is detached while
  // they happen.
  function apply() {
    if (!running) return;
    if (observer) observer.disconnect();
    try {
      var anchors = document.querySelectorAll(ANCHOR_SEL);
      for (var i = 0; i < anchors.length; i++) applyAnchor(anchors[i]);
    } catch (e) {}
    if (observer && observedRoot && observedRoot.isConnected) {
      observer.observe(observedRoot, { childList: true, subtree: true });
    }
  }
  function scheduleApply() {
    if (applyTimer) return;
    applyTimer = setTimeout(function () { applyTimer = 0; apply(); }, 50);
  }

  // Re-attach whenever upstream replaces the sidebar root.
  function watch() {
    if (!running) return;
    var root = document.querySelector(".dframe-sidebar");
    if (root && root !== observedRoot) {
      if (observer) observer.disconnect();
      observedRoot = root;
      observer = new MutationObserver(scheduleApply);
      apply();
    }
  }

  // ---- the context-menu entry -------------------------------------------------
  function onContextMenu(ev) {
    pending = null;
    var el = ev.target;
    if (!(el instanceof Element)) return;
    var label = el.closest('[class~="group/labelrow"]');
    var section = label && label.closest(SECTION_SEL);
    if (!section || !section.parentElement || !section.parentElement.matches(ANCHOR_SEL)) return;
    var key = keyOf(section);
    if (key) { pending = { key: key, at: Date.now() }; awaitMenu(0); }
  }

  function findMenu() {
    var menus = document.querySelectorAll('[role="menu"]');
    for (var i = menus.length - 1; i >= 0; i--) {
      if (menus[i].querySelector('[role="menuitem"]')) return menus[i];
    }
    return null;
  }
  function awaitMenu(tries) {
    if (!pending || !running) return;
    var menu = findMenu();
    if (menu) {
      if (!menu.querySelector("[data-cdb-pin-item]")) addMenuItem(menu, pending.key);
      return;
    }
    if (tries < 20) setTimeout(function () { awaitMenu(tries + 1); }, 50);
  }

  function ownText(el) {
    var s = "";
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) s += c.nodeValue.trim();
    }
    return s;
  }

  function addMenuItem(menu, key) {
    var tpl = menu.querySelector('[role="menuitem"]');
    if (!tpl) return;
    var item = tpl.cloneNode(true);
    ["id", "data-highlighted", "data-disabled", "aria-disabled", "disabled", "data-state"]
      .forEach(function (a) { item.removeAttribute(a); });
    // Keep the first labelled element as the label; drop icons and any other
    // text (shortcut hints) the template carried.
    var all = item.querySelectorAll("*"), label = null, i;
    for (i = 0; i < all.length; i++) {
      if (!label && ownText(all[i])) label = all[i];
    }
    if (!label && ownText(item)) label = item;
    for (i = all.length - 1; i >= 0; i--) {
      var n = all[i];
      if (n === label || (label && n.contains(label))) continue;
      if (n.tagName === "svg" || n.tagName === "IMG" || ownText(n) || !n.children.length) n.remove();
    }
    if (!label) { label = document.createElement("span"); item.appendChild(label); }
    label.textContent = t(isPinned(key) ? "unpin" : "pin");
    item.setAttribute("data-cdb-pin-item", "");

    function others() { return menu.querySelectorAll("[data-highlighted]"); }
    item.addEventListener("mouseenter", function () {
      var hl = others();
      for (var j = 0; j < hl.length; j++) hl[j].removeAttribute("data-highlighted");
      item.setAttribute("data-highlighted", "");
    });
    item.addEventListener("mouseleave", function () { item.removeAttribute("data-highlighted"); });
    item.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      togglePin(key);
      pending = null;
      try { console.debug(CLOSE_MSG); } catch (e) {}
    });

    var sep = menu.querySelector('[role="separator"]');
    if (sep && sep.parentNode) sep.parentNode.insertBefore(item, sep.nextSibling);
    else if (tpl.parentNode) tpl.parentNode.insertBefore(item, tpl.nextSibling);
  }

  // ---- lifecycle --------------------------------------------------------------
  function start() {
    if (running) return;
    running = true;
    load();
    document.addEventListener("contextmenu", onContextMenu, true);
    watchTimer = setInterval(watch, 1000);
    watch();
  }

  function stop() {
    if (!running) return;
    running = false;
    document.removeEventListener("contextmenu", onContextMenu, true);
    clearInterval(watchTimer);
    clearTimeout(applyTimer);
    applyTimer = 0;
    if (observer) observer.disconnect();
    observer = null;
    observedRoot = null;
    pending = null;
    var anchors = document.querySelectorAll(ANCHOR_SEL);
    for (var i = 0; i < anchors.length; i++) clearAnchor(anchors[i]);
  }

  window.__cdbSidebarPins = { start: start, stop: stop };
})();
