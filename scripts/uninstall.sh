#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this uninstaller as root." >&2
  exit 1
fi

PURGE=0
if [[ "${1:-}" == "--purge" ]]; then
  PURGE=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--purge]" >&2
  exit 2
fi

systemctl disable --now sajadbot-whatsapp.service 2>/dev/null || true
rm -f -- /etc/systemd/system/sajadbot-whatsapp.service /usr/local/bin/sajadbot-wa
systemctl daemon-reload
rm -rf -- /opt/sajadbot-whatsapp

if [[ "${PURGE}" -eq 1 ]]; then
  echo "Purging database, staged media, authentication state, configuration, and logs."
  rm -rf -- /var/lib/sajadbot-whatsapp /etc/sajadbot-whatsapp /var/log/sajadbot-whatsapp
  userdel sajadbot-wa 2>/dev/null || true
  groupdel sajadbot-wa 2>/dev/null || true
else
  echo "Application removed. State and configuration were preserved."
  echo "Use --purge only if permanent credential/database deletion is intended."
fi
