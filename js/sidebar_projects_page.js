/*
 * sidebar_projects_page.js - page half of the sidebar projects feature,
 * injected into the claude.ai page by js/sidebar_projects_main.js on dom-ready.
 *
 * DIAGNOSTIC STAGE: the only thing it exposes is dump(), a structural snapshot
 * of the sidebar (tags, classes, a few state attributes, and the computed type
 * and indent of every text row) so the real selectors can be chosen from
 * measurements instead of guesses. It never touches the DOM.
 *
 * PRIVACY: no text content leaves the page. Text nodes are recorded as their
 * length only; every attribute outside KEEP_VALUE (aria-label, title, href,
 * id, data-* ...) is recorded as its name plus the value's length. A session
 * title therefore cannot end up in the dump.
 */
(function () {
  "use strict";
  if (window.__cdbSidebarProjects) return;

  var MAX_NODES = 6000;
  var MAX_DEPTH = 60;
  var KEEP_VALUE = {
    "class": 1, "role": 1, "type": 1, "tabindex": 1, "disabled": 1,
    "aria-expanded": 1, "aria-haspopup": 1, "aria-selected": 1, "aria-current": 1,
    "aria-pressed": 1, "aria-hidden": 1, "aria-level": 1,
    "data-state": 1, "data-testid": 1, "data-orientation": 1, "data-active": 1,
    "data-selected": 1, "data-expanded": 1, "data-collapsed": 1
  };

  function findRoot() {
    return document.querySelector(".dframe-sidebar") || document.querySelector("nav");
  }

  function attrsOf(el) {
    var out = {}, n = 0;
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (KEEP_VALUE[a.name]) out[a.name] = a.value;
      else out[a.name] = "~" + String(a.value).length;
      n++;
    }
    return n ? out : undefined;
  }

  function ownTextLength(el) {
    var len = 0;
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) len += c.nodeValue.trim().length;
    }
    return len;
  }

  function styleOf(el, rootLeft) {
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    return {
      fontSize: cs.fontSize, fontWeight: cs.fontWeight, color: cs.color,
      paddingLeft: cs.paddingLeft, marginLeft: cs.marginLeft,
      left: Math.round(r.left - rootLeft), height: Math.round(r.height)
    };
  }

  function dump() {
    var root = findRoot();
    if (!root) return null;
    var rootLeft = root.getBoundingClientRect().left;
    var count = 0, truncated = false;

    function walk(el, depth) {
      if (count >= MAX_NODES || depth > MAX_DEPTH) { truncated = true; return null; }
      count++;
      var node = { tag: el.tagName.toLowerCase() };
      var at = attrsOf(el);
      if (at) node.attrs = at;
      var tl = ownTextLength(el);
      if (tl) { node.text = tl; node.cs = styleOf(el, rootLeft); }
      if (node.tag !== "svg" && el.children.length) {
        node.kids = [];
        for (var i = 0; i < el.children.length; i++) {
          var k = walk(el.children[i], depth + 1);
          if (k) node.kids.push(k);
        }
      }
      return node;
    }

    var tree = walk(root, 0);
    return {
      url: location.origin + location.pathname.replace(/[0-9a-f-]{8,}/gi, ":id"),
      time: new Date().toISOString(),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      nodeCount: count,
      truncated: truncated,
      tree: tree
    };
  }

  window.__cdbSidebarProjects = { dump: dump };
})();
