# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Sidebar projects: a clearer project / session hierarchy in the sidebar
# (larger, coloured project headings, indented sessions).
#
# Injects js/sidebar_projects_main.js: the opt-in pref (cdb-sidebar:pref-read /
# pref-set, driven by the Settings -> Extra row) and the stylesheet it inserts
# into and removes from the claude.ai page live. js/sidebar_projects_page.js is
# embedded for the diagnostic only: with CLAUDE_SIDEBAR_DUMP=1 set, the module
# also writes a text-free structural snapshot of the sidebar to the profile
# directory, to re-derive the selectors after an upstream redesign.
#
# Break risk: VERY LOW for the injection (stable "use strict"; anchor, no regex
# on minified code). The stylesheet keys off remote claude.ai classes and
# degrades to a no-op on a redeploy: unmatched selectors change nothing.

import std/[os, strutils]

const MAIN_JS = staticRead("../../js/sidebar_projects_main.js")
const PAGE_JS = staticRead("../../js/sidebar_projects_page.js")

const MARKER = "__CDB_SIDEBAR_PROJECTS__"
const PLACEHOLDER = "\"__CDB_SIDEBAR_PAGE_SRC__\""

proc escapeJs(s: string): string =
  result = s
  result = result.replace("\\", "\\\\")
  result = result.replace("\"", "\\\"")
  result = result.replace("\n", "\\n")
  result = result.replace("\r", "")

proc buildInjection(): string =
  if PLACEHOLDER notin MAIN_JS:
    raise newException(ValueError, "sidebar_projects_main.js lost its page-src placeholder")
  MAIN_JS.replace(PLACEHOLDER, "\"" & escapeJs(PAGE_JS) & "\"")

proc apply*(input: string): string =
  result = input
  # Idempotency: positive end-state assertion (Rule 6).
  if MARKER in result:
    echo "  [OK] sidebar projects: injection already present (idempotent)"
    return
  let injection = buildInjection()
  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & injection & result[strictPrefix.len .. ^1]
    echo "  [OK] sidebar projects injected after \"use strict\""
  else:
    result = injection & result
    echo "  [OK] sidebar projects prepended"
  if result.count(MARKER) != 1:
    echo "  [FAIL] sidebar projects: injection not present exactly once after patching"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_sidebar_projects <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_sidebar_projects ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] sidebar projects applied"
  else:
    if MARKER notin output:
      echo "  [FAIL] No changes made and injection is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
