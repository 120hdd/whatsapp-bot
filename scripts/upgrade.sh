#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this upgrade as root." >&2
  exit 1
fi

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_DIR="/opt/sajadbot-whatsapp"
CONFIG_DIR="/etc/sajadbot-whatsapp"
SOURCE_RECORD="${CONFIG_DIR}/source-path"
if [[ ! -d "${APP_DIR}" || ! -f "${SOURCE_DIR}/dist/cli/index.js" ]]; then
  echo "Installation or build output is missing." >&2
  exit 1
fi

WAS_ACTIVE=0
if systemctl is-active --quiet sajadbot-whatsapp.service; then
  WAS_ACTIVE=1
  systemctl stop sajadbot-whatsapp.service
fi

cp -a -- "${SOURCE_DIR}/dist/." "${APP_DIR}/dist/"
install -o root -g root -m 0644 "${SOURCE_DIR}/package.json" "${APP_DIR}/package.json"
install -o root -g root -m 0644 "${SOURCE_DIR}/package-lock.json" "${APP_DIR}/package-lock.json"
install -o root -g root -m 0644 "${SOURCE_DIR}/README.md" "${APP_DIR}/README.md"
install -d -o root -g sajadbot-wa -m 0750 "${CONFIG_DIR}"
printf '%s\n' "${SOURCE_DIR}" >"${SOURCE_RECORD}"
chown root:root "${SOURCE_RECORD}"
chmod 0600 "${SOURCE_RECORD}"
(
  cd -- "${APP_DIR}"
  npm ci --omit=dev --no-audit --no-fund
)
cat >/usr/local/bin/wts <<'EOF'
#!/usr/bin/env bash
exec node /opt/sajadbot-whatsapp/dist/cli/index.js "$@"
EOF
chmod 0755 /usr/local/bin/wts
ln -sfn /usr/local/bin/wts /usr/local/bin/sajadbot-wa
install -o root -g root -m 0644 "${SOURCE_DIR}/deploy/sajadbot-whatsapp.service" /etc/systemd/system/sajadbot-whatsapp.service
systemctl daemon-reload

if [[ "${WAS_ACTIVE}" -eq 1 ]]; then
  systemctl start sajadbot-whatsapp.service
fi
echo "Upgrade complete. Database and authentication state were preserved."
