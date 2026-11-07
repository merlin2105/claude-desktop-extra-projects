#!/usr/bin/env python3
"""Claude Desktop Update - kleine Qt-App fuer den Update-Ablauf.

Baut die neueste offizielle Claude-Desktop-Version mit allen eigenen Aenderungen
(scripts/update-mine.sh), installiert das Paket mit sudo und zeigt den Fortschritt.
Das sudo-Passwort fragt ein KDE-Dialog ab (scripts/update-askpass.sh, SUDO_ASKPASS):
es geht direkt an sudo und nie durch diese App.

    claude-desktop-update-gui.py [--skip-tests] [--force]

Zuerst wird geprueft (ohne Passwort), ob das Original ein neueres Release hat als das
installierte Paket: derselbe Vergleich wie beim Hinweis "Update verfuegbar" in Claude
Desktop. Nur wenn ja, kommt die Passwortabfrage und der Bau. --force baut auch ohne
neue Version.

Nur fuer Tests ersetzen CDU_CHECK_CMD, CDU_INSTALLED_TAG, CDU_AUTH_CMD, CDU_UPDATE_CMD,
CDU_INSTALL_CMD und CDU_CLAUDE_CMD die Befehle bzw. den installierten Stempel
(Shell-Zeile, per shlex zerlegt; beim Installbefehl wird der Paketpfad angehaengt).
"""
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path

from PySide6.QtCore import QProcess, QProcessEnvironment, QTimer
from PySide6.QtGui import QGuiApplication, QIcon
from PySide6.QtWidgets import (QApplication, QHBoxLayout, QLabel, QMessageBox,
                               QPlainTextEdit, QProgressBar, QPushButton,
                               QVBoxLayout, QWidget)

REPO = Path(__file__).resolve().parent.parent
UPDATE_SH = REPO / "scripts" / "update-mine.sh"
ASKPASS = REPO / "scripts" / "update-askpass.sh"
PKG = "claude-desktop-extra"
TEST_TOTAL = 74  # Zahl der Feature-Tests (scripts/run-feature-tests.sh)
CLAUDE_PROC = r"^/usr/lib/claude-desktop/claude( |$)"

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
TEST_LINE = re.compile(r"^\s*(PASS|SKIP|FAIL)\s+tests/")
PKG_LINE = re.compile(r"^\s*sudo pacman -U (\S+\.pkg\.tar\.zst)\s*$")
TAG_LINE = re.compile(r"refs/tags/v(\d+)\.(\d+)\.(\d+)(?:-(\d+))?\s*$")
TAG_TEXT = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$")
RELEASE_JSON = Path("/usr/lib/claude-desktop/resources/cdb-release.json")

# (Muster, Prozent, Text): die Phasen des Baus in ihrer Reihenfolge. Der Balken
# springt nie zurueck und kriecht innerhalb einer Phase langsam auf die naechste zu.
STAGES = [
    (r"^>> Hole Neuerungen", 2, "Hole Neuerungen vom Original …"),
    (r"^>> Feature-Tests", 5, "Teste die Änderungen …"),
    (r"^>> Neuester Release", 31, "Bereite den Bau vor …"),
    (r"^>> Baue die neueste", 32, "Lade die neueste Claude-Version …"),
    (r"Downloading \.deb", 34, "Lade Claude Desktop von Anthropic herunter …"),
    (r"SHA256 verified", 40, "Download geprüft …"),
    (r"Extracting \.deb", 42, "Entpacke die Version …"),
    (r"Compiling Nim patches", 48, "Übersetze die Patches …"),
    (r"Applying patches", 58, "Wende die Patches an …"),
    (r"Validating JavaScript syntax", 70, "Prüfe das Ergebnis …"),
    (r"Repacking app\.asar", 74, "Packe das Programm …"),
    (r"Repacking ion-dist\.asar", 78, "Packe das Programm …"),
    (r"Creating tarball:", 82, "Packe das Programm …"),
    (r"Building Arch package", 86, "Baue das Arch-Paket …"),
]
PCT_BUILT = 92      # Paket gebaut
PCT_INSTALL = 94    # Installation laeuft
PCT_INSTALLING = 97


class Progress:
    """Wandelt die Ausgabezeilen des Skripts in (Prozent, Text) um."""

    def __init__(self):
        self.pct = 0.0
        self.text = "Starte …"
        self.ceiling = float(STAGES[0][1]) - 1
        self.tests_seen = 0
        self._stage = -1
        self._compiled = [(re.compile(p), pct, txt) for p, pct, txt in STAGES]

    def _set_stage(self, i):
        self._stage = i
        _, pct, txt = self._compiled[i]
        self.pct = max(self.pct, float(pct))
        self.text = txt
        nxt = self._compiled[i + 1][1] if i + 1 < len(self._compiled) else PCT_BUILT
        self.ceiling = float(nxt) - 1

    def feed(self, line):
        line = ANSI.sub("", line)
        if TEST_LINE.match(line):
            self.tests_seen += 1
            n = min(self.tests_seen, TEST_TOTAL)
            self.pct = max(self.pct, 5 + 25 * n / TEST_TOTAL)
            self.text = "Teste die Änderungen (%d von %d) …" % (n, TEST_TOTAL)
            self.ceiling = 30.0
            return
        for i, (rx, _pct, _txt) in enumerate(self._compiled):
            if i > self._stage and rx.search(line):
                self._set_stage(i)
                return

    def creep(self):
        if self.pct < self.ceiling:
            self.pct += (self.ceiling - self.pct) * 0.03

    def jump(self, pct, text, ceiling=None):
        self.pct = max(self.pct, float(pct))
        self.text = text
        self.ceiling = float(ceiling if ceiling is not None else pct)


def env_cmd(name, default):
    raw = os.environ.get(name)
    return shlex.split(raw) if raw else default


def tag_key(m):
    """Release-Tag v<X>.<Y>.<Z>[-<N>] als Vergleichsschluessel; N fehlt = 1 (wie in Claude Desktop)."""
    x, y, z, n = m.groups()
    return (int(x), int(y), int(z), int(n) if n else 1)


def tag_text(key):
    x, y, z, n = key
    return "v%d.%d.%d%s" % (x, y, z, "" if n == 1 else "-%d" % n)


def installed_key():
    """Stempel des installierten Pakets, den auch der Hinweis in Claude Desktop vergleicht."""
    try:
        tag = os.environ.get("CDU_INSTALLED_TAG") or json.loads(RELEASE_JSON.read_text())["tag"]
    except (OSError, ValueError, KeyError):
        parts = subprocess.run(["pacman", "-Q", PKG], capture_output=True, text=True).stdout.split()
        tag = "v" + parts[1] if len(parts) == 2 else ""
    m = TAG_TEXT.match(tag)
    return tag_key(m) if m else None


class Updater(QWidget):
    def __init__(self, skip_tests, force=False):
        super().__init__()
        self.skip_tests = skip_tests
        self.force = force
        self.progress = Progress()
        self.state = "check"         # check | uptodate | auth | update | install | done | error
        self.tags = []
        self.found = ""
        self.pkg_path = None
        self._buf = ""
        self.proc = None

        self.setWindowTitle("Claude Desktop Update")
        self.setWindowIcon(QIcon.fromTheme("system-software-update"))
        self.setFixedWidth(560)

        self.title = QLabel("Claude Desktop Update")
        f = self.title.font()
        f.setPointSize(f.pointSize() + 5)
        f.setBold(True)
        self.title.setFont(f)
        self.sub = QLabel("")
        self.sub.setWordWrap(True)
        self.bar = QProgressBar()
        self.bar.setRange(0, 100)
        self.details_btn = QPushButton("Details anzeigen")
        self.details_btn.setCheckable(True)
        self.details_btn.setFlat(True)
        self.details_btn.toggled.connect(self._toggle_details)
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumBlockCount(4000)
        self.log.setMinimumHeight(220)
        self.log.setVisible(False)
        self.action_btn = QPushButton("")
        self.action_btn.setVisible(False)
        self.close_btn = QPushButton("Schließen")
        self.close_btn.clicked.connect(self.close)

        row = QHBoxLayout()
        row.addWidget(self.details_btn)
        row.addStretch(1)
        row.addWidget(self.action_btn)
        row.addWidget(self.close_btn)
        lay = QVBoxLayout(self)
        lay.addWidget(self.title)
        lay.addWidget(self.sub)
        lay.addWidget(self.bar)
        lay.addLayout(row)
        lay.addWidget(self.log)

        self.creep_timer = QTimer(self)
        self.creep_timer.timeout.connect(self._tick)
        self.creep_timer.start(500)
        self.keepalive = QTimer(self)
        self.keepalive.timeout.connect(self._keepalive)

        self._render()
        QTimer.singleShot(0, self.start_auth if force else self.start_check)

    # ---- Anzeige ----------------------------------------------------------
    def _render(self):
        self.bar.setValue(int(self.progress.pct))
        if self.state not in ("done", "error", "uptodate"):
            self.sub.setText(self.progress.text)

    def _tick(self):
        if self.state == "update":
            self.progress.creep()
            self._render()

    def _toggle_details(self, on):
        self.log.setVisible(on)
        self.details_btn.setText("Details ausblenden" if on else "Details anzeigen")
        self.adjustSize()

    # ---- Prozesse ---------------------------------------------------------
    def _run(self, argv, on_line, on_done, askpass=False, new_session=False):
        p = QProcess(self)
        p.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        env = QProcessEnvironment.systemEnvironment()
        if askpass:
            env.insert("SUDO_ASKPASS", str(ASKPASS))
        p.setProcessEnvironment(env)
        p.setWorkingDirectory(str(REPO))
        self._buf = ""

        def ready():
            data = bytes(p.readAllStandardOutput()).decode("utf-8", "replace")
            self._buf += data.replace("\r", "\n")
            *lines, self._buf = self._buf.split("\n")
            for ln in lines:
                ln = ANSI.sub("", ln).rstrip()
                if ln:
                    self.log.appendPlainText(ln)
                    on_line(ln)
            self._render()

        p.readyReadStandardOutput.connect(ready)
        p.finished.connect(lambda code, _st: (ready(), on_done(code)))
        if new_session:  # eigene Prozessgruppe, damit "Abbrechen" auch die Kinder trifft
            p.start("setsid", argv)
        else:
            p.start(argv[0], argv[1:])
        self.proc = p
        return p

    def _kill_tree(self):
        p = self.proc
        if p is not None and p.state() != QProcess.ProcessState.NotRunning:
            try:
                os.killpg(p.processId(), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                p.terminate()
            p.waitForFinished(3000)

    # ---- 0. Gibt es eine neue Version? (ohne Passwort) --------------------
    def start_check(self):
        self.state = "check"
        self.tags = []
        self.title.setText("Claude Desktop Update")
        self.sub.setStyleSheet("")
        self.bar.setRange(0, 0)  # unbestimmt: es dauert nur eine Sekunde
        self.progress.jump(0, "Prüfe, ob es eine neue Version gibt …")
        self._render()
        argv = env_cmd("CDU_CHECK_CMD", ["git", "ls-remote", "--tags", "--refs", "upstream"])
        self._run(argv, self._check_line, self._check_done)

    def _check_line(self, ln):
        m = TAG_LINE.search(ln)
        if m:
            self.tags.append(tag_key(m))

    def _check_done(self, code):
        self.bar.setRange(0, 100)
        if code != 0 or not self.tags:
            self._fail("Konnte nicht prüfen, ob es eine neue Version gibt (kein Internet?).",
                       retry=self.start_check, details=True)
            return
        latest, mine = max(self.tags), installed_key()
        if mine is not None and latest <= mine:
            self._uptodate(latest, mine)
            return
        self.found = "Neue Version gefunden: %s" % tag_text(latest)
        if mine is not None:
            self.found += " (installiert: %s)" % tag_text(mine)
        self.start_auth()

    def _uptodate(self, latest, mine):
        self.state = "uptodate"
        self.bar.setVisible(False)
        self.title.setText("Alles aktuell")
        self.sub.setText("Installiert: %s – neueste Version beim Original: %s. "
                         "Es gibt nichts zu aktualisieren." % (tag_text(mine), tag_text(latest)))
        self.action_btn.setText("Trotzdem neu bauen")
        self.action_btn.setToolTip("Baut und installiert das Paket neu, zum Beispiel nach eigenen Änderungen.")
        self.action_btn.setVisible(True)
        self.action_btn.clicked.connect(self._force_rebuild)

    def _force_rebuild(self):
        self.action_btn.setVisible(False)
        self.action_btn.clicked.disconnect()
        self.bar.setVisible(True)
        self.found = ""
        self.start_auth()

    # ---- 1. sudo-Passwort -------------------------------------------------
    def start_auth(self):
        self.state = "auth"
        self.progress.jump(0, (self.found + " – " if self.found else "") + "Bitte das sudo-Passwort eingeben …")
        self._render()
        argv = env_cmd("CDU_AUTH_CMD", ["sudo", "-A", "-v"])
        self._run(argv, lambda ln: None, self._auth_done, askpass=True)

    def _auth_done(self, code):
        if code != 0:
            self._fail("Ohne Passwort kann das Update nicht installiert werden.",
                       retry=self.start_auth)
            return
        self.keepalive.start(60_000)  # haelt die sudo-Berechtigung waehrend des Baus am Leben
        self.start_update()

    def _keepalive(self):
        if os.environ.get("CDU_AUTH_CMD"):
            return
        try:
            subprocess.run(["sudo", "-n", "-v"], timeout=10, capture_output=True)
        except (subprocess.SubprocessError, OSError):
            pass

    # ---- 2. Update bauen --------------------------------------------------
    def start_update(self):
        self.state = "update"
        self.progress = Progress()
        self.progress.jump(1, "Starte das Update …", ceiling=2)
        argv = env_cmd("CDU_UPDATE_CMD", ["bash", str(UPDATE_SH)])
        if self.skip_tests and "CDU_UPDATE_CMD" not in os.environ:
            argv.append("--skip-tests")
        self._run(argv, self._update_line, self._update_done, new_session=True)

    def _update_line(self, ln):
        m = PKG_LINE.match(ln)
        if m:
            self.pkg_path = m.group(1)
        self.progress.feed(ln)

    def _update_done(self, code):
        if code != 0:
            self._fail("Das Update ist fehlgeschlagen. Unter „Details“ steht der Grund.", details=True)
            return
        if not self.pkg_path or not Path(self.pkg_path).exists():
            self._fail("Das Paket wurde nicht gefunden.", details=True)
            return
        self.progress.jump(PCT_BUILT, "Paket gebaut …")
        self.start_install()

    # ---- 3. installieren --------------------------------------------------
    def start_install(self):
        self.state = "install"
        self.close_btn.setEnabled(False)  # eine halbe Installation waere schlimmer als warten
        self.progress.jump(PCT_INSTALL, "Installiere das Paket …")
        self._render()
        argv = env_cmd("CDU_INSTALL_CMD", ["sudo", "-A", "pacman", "-U", "--noconfirm"])
        self._run(argv + [self.pkg_path], self._install_line, self._install_done, askpass=True)

    def _install_line(self, ln):
        if re.search(r"Aktualisiert wird|upgrading|installing|Installiere", ln, re.I):
            self.progress.jump(PCT_INSTALLING, "Installiere das Paket …")

    def _install_done(self, code):
        self.close_btn.setEnabled(True)
        if code != 0:
            self._fail("Die Installation ist fehlgeschlagen. Unter „Details“ steht der Grund.", details=True)
            return
        self._drop_sudo()
        self.state = "done"
        self.progress.jump(100, "")
        version = self._installed_version()
        self.title.setText("Fertig – alles erledigt")
        self.sub.setText("Installiert: %s%s" % (PKG, " " + version if version else ""))
        running = self._claude_running()
        self.action_btn.setText("Claude Desktop neu starten" if running else "Claude Desktop starten")
        if running:
            self.action_btn.setToolTip("Beendet das laufende Claude Desktop (offene Sitzungen enden).")
        self.action_btn.setDefault(True)
        self.action_btn.setVisible(True)
        self.action_btn.clicked.connect(self.launch_claude)
        self._render()
        self.raise_()
        self.activateWindow()

    # ---- Ende / Fehler ----------------------------------------------------
    def _drop_sudo(self):
        self.keepalive.stop()
        if not os.environ.get("CDU_AUTH_CMD"):
            subprocess.run(["sudo", "-k"], capture_output=True)

    def _fail(self, msg, retry=None, details=False):
        self.state = "error"
        self._drop_sudo()
        self.title.setText("Das hat nicht geklappt")
        self.sub.setText(msg)
        self.sub.setStyleSheet("color: #d9534f;")
        if details:
            self.details_btn.setChecked(True)
        if retry:
            self.action_btn.setText("Erneut versuchen")
            self.action_btn.setVisible(True)
            self.action_btn.clicked.connect(lambda: self._retry(retry))
        self._render()

    def _retry(self, fn):
        self.action_btn.setVisible(False)
        self.action_btn.clicked.disconnect()
        self.title.setText("Claude Desktop Update")
        self.sub.setStyleSheet("")
        fn()

    # ---- Claude starten ---------------------------------------------------
    @staticmethod
    def _claude_running():
        return subprocess.run(["pgrep", "-f", CLAUDE_PROC], capture_output=True).returncode == 0

    def launch_claude(self):
        self.action_btn.setEnabled(False)
        if self._claude_running():
            subprocess.run(["pkill", "-TERM", "-f", CLAUDE_PROC])
            for _ in range(60):
                if not self._claude_running():
                    break
                time.sleep(0.25)
        launcher = os.environ.get("CDU_CLAUDE_CMD") or "claude-desktop"
        subprocess.Popen(shlex.split(launcher), start_new_session=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
        self.close()

    @staticmethod
    def _installed_version():
        r = subprocess.run(["pacman", "-Q", PKG], capture_output=True, text=True)
        parts = r.stdout.split()
        return parts[1] if len(parts) == 2 else ""

    # ---- Schliessen -------------------------------------------------------
    def closeEvent(self, ev):
        if self.state == "install":
            ev.ignore()
            return
        if self.state == "update":
            ans = QMessageBox.question(
                self, "Update abbrechen?",
                "Das Update läuft noch. Wirklich abbrechen? Es wird nichts installiert.")
            if ans != QMessageBox.StandardButton.Yes:
                ev.ignore()
                return
        if self.state in ("check", "auth", "update"):
            self._kill_tree()
            if self.state != "check":
                self._drop_sudo()
        ev.accept()


def main():
    app = QApplication(sys.argv)
    QGuiApplication.setDesktopFileName("claude-desktop-update")
    app.setApplicationName("Claude Desktop Update")
    args = sys.argv[1:]
    w = Updater(skip_tests="--skip-tests" in args, force="--force" in args)
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
