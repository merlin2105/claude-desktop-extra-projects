#!/usr/bin/env bash
# Holt die neuesten Aenderungen vom Original (upstream), fuehrt sie mit den eigenen
# Aenderungen (Branch sidebar-projects) zusammen, baut die neueste OFFIZIELLE
# Claude-Desktop-Version mit allen Patches und gibt den Installationsbefehl aus.
#
#   ./scripts/update-mine.sh                 # holen, zusammenfuehren, testen, bauen
#   ./scripts/update-mine.sh --install       # ... und gleich installieren (sudo pacman -U)
#   ./scripts/update-mine.sh --skip-tests    # ohne die Feature-Tests (schneller)
#
# Bei einem Merge-Konflikt bricht das Skript ab: Konflikte loesen, "git commit",
# dann das Skript erneut starten.
set -euo pipefail

BRANCH=sidebar-projects
PKG=claude-desktop-extra
TOOLS="${CLAUDE_BUILD_TOOLS:-$HOME/.local/share/claude-desktop-extra-build-tools}"

INSTALL=false
SKIP_TESTS=false
for arg in "$@"; do
    case "$arg" in
        --install) INSTALL=true ;;
        --skip-tests) SKIP_TESTS=true ;;
        -h|--help) sed -n 2,11p "$0"; exit 0 ;;
        *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
    esac
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [ "$(git branch --show-current)" != "$BRANCH" ]; then
    echo "Bitte zuerst auf den Branch $BRANCH wechseln (git checkout $BRANCH)." >&2
    exit 1
fi
if ! git diff --quiet HEAD; then
    echo "Es gibt nicht committete Aenderungen. Erst committen oder verwerfen." >&2
    exit 1
fi

# Werkzeuge: der Bau braucht asar und Node >= 24 (das System-Node 22 reicht nicht).
# Beide liegen in $TOOLS und beruehren das System nicht.
if [ ! -x "$TOOLS/node_modules/node-linux-x64/bin/node" ] || [ ! -x "$TOOLS/node_modules/.bin/asar" ]; then
    echo ">> Installiere Build-Werkzeuge (asar, Node 24) nach $TOOLS"
    mkdir -p "$TOOLS"
    npm install --prefix "$TOOLS" --no-audit --no-fund @electron/asar@3.2.18 node-linux-x64@24
fi
export PATH="$TOOLS/node_modules/node-linux-x64/bin:$TOOLS/node_modules/.bin:$PATH"

echo ">> Hole Neuerungen vom Original"
git fetch upstream
git checkout -q master
git merge --ff-only upstream/master
git checkout -q "$BRANCH"
if ! git merge --no-edit master; then
    echo "Merge-Konflikt. Konflikte loesen, 'git commit', dann dieses Skript erneut starten." >&2
    exit 1
fi

if [ "$SKIP_TESTS" = false ]; then
    echo ">> Feature-Tests"
    bash scripts/run-feature-tests.sh
fi

echo ">> Baue die neueste offizielle Version mit allen Patches"
rm -f build/"$PKG"-*.pkg.tar.zst
if [ "$INSTALL" = true ]; then
    ./scripts/build-local.sh --install
    echo ">> Fertig. Claude Desktop neu starten."
else
    ./scripts/build-local.sh
    PKGFILE="$(ls -t "$REPO_DIR"/build/"$PKG"-*.pkg.tar.zst | head -1)"
    echo
    echo ">> Fertig. Installieren mit:"
    echo "   sudo pacman -U $PKGFILE"
fi

# Ohne IgnorePkg wuerde das naechste "yay -Syu" die Standardvariante wieder
# ueber diese Version installieren.
if ! pacman-conf IgnorePkg 2>/dev/null | grep -qx "$PKG"; then
    echo
    echo "HINWEIS: In /etc/pacman.conf fehlt 'IgnorePkg = $PKG'."
    echo "Ohne diese Zeile ersetzt ein normales Systemupdate diese Version durch die Standardvariante."
fi
