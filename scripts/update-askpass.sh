#!/usr/bin/env bash
# Passwortabfrage fuer "sudo -A" (SUDO_ASKPASS): ein Dialog, dessen Eingabe direkt an
# sudo geht. Die aufrufende App sieht das Passwort nie.
prompt="${1:-Passwort für sudo:}"
if command -v kdialog >/dev/null 2>&1; then
    exec kdialog --title "Claude Desktop Update" --password "$prompt"
elif command -v zenity >/dev/null 2>&1; then
    exec zenity --password --title="Claude Desktop Update"
fi
echo "Weder kdialog noch zenity gefunden" >&2
exit 1
