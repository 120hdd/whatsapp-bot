#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
APP_DIR="/opt/sajadbot-whatsapp"
CONFIG_DIR="/etc/sajadbot-whatsapp"
STATE_DIR="/var/lib/sajadbot-whatsapp"
LOG_DIR="/var/log/sajadbot-whatsapp"
SERVICE_USER="sajadbot-wa"
SERVICE_FILE="/etc/systemd/system/sajadbot-whatsapp.service"

command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required." >&2; exit 1; }
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "Node.js 20 or newer is required." >&2
  exit 1
fi
if [[ ! -d "${SOURCE_DIR}/dist" || ! -f "${SOURCE_DIR}/package-lock.json" ]]; then
  echo "Build the project and install dependencies first: npm ci && npm run build" >&2
  exit 1
fi

if ! getent group "${SERVICE_USER}" >/dev/null; then
  groupadd --system "${SERVICE_USER}"
fi
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${SERVICE_USER}" --home-dir "${STATE_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

install -d -o root -g root -m 0755 "${APP_DIR}" "${APP_DIR}/dist"
install -d -o root -g "${SERVICE_USER}" -m 0750 "${CONFIG_DIR}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0700 "${STATE_DIR}" "${STATE_DIR}/media"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0700 "${LOG_DIR}"

cp -a -- "${SOURCE_DIR}/dist/." "${APP_DIR}/dist/"
install -o root -g root -m 0644 "${SOURCE_DIR}/package.json" "${APP_DIR}/package.json"
install -o root -g root -m 0644 "${SOURCE_DIR}/package-lock.json" "${APP_DIR}/package-lock.json"
install -o root -g root -m 0644 "${SOURCE_DIR}/README.md" "${APP_DIR}/README.md"

(
  cd -- "${APP_DIR}"
  npm ci --omit=dev --no-audit --no-fund
)

if [[ ! -f "${CONFIG_DIR}/bot.env" ]]; then
  install -o root -g "${SERVICE_USER}" -m 0640 /dev/null "${CONFIG_DIR}/bot.env"
  cat >"${CONFIG_DIR}/bot.env" <<'EOF'
DATABASE_PATH=/var/lib/sajadbot-whatsapp/app.db
STATE_DIR=/var/lib/sajadbot-whatsapp
MEDIA_DIR=/var/lib/sajadbot-whatsapp/media
LOCK_PATH=/var/lib/sajadbot-whatsapp/daemon.lock
LOG_LEVEL=info
TIMEZONE=UTC
DRY_RUN=false
WORKER_POLL_MS=1000
SEND_INTERVAL_MS=8000
MAX_ATTEMPTS=5
RETRY_BASE_MS=5000
RETRY_MAX_MS=300000
MAX_MEDIA_BYTES=2147483648
SELF_CONTROLLER_ENABLED=false
EOF
  chown root:"${SERVICE_USER}" "${CONFIG_DIR}/bot.env"
  chmod 0640 "${CONFIG_DIR}/bot.env"
fi

install -o root -g root -m 0644 "${SOURCE_DIR}/deploy/sajadbot-whatsapp.service" "${SERVICE_FILE}"
cat >/usr/local/bin/sajadbot-wa <<'EOF'
#!/usr/bin/env bash
exec node /opt/sajadbot-whatsapp/dist/cli/index.js "$@"
EOF
chmod 0755 /usr/local/bin/sajadbot-wa

systemctl daemon-reload
systemctl enable sajadbot-whatsapp.service

echo "Installed. Authenticate before starting:"
echo "  sudo -u ${SERVICE_USER} sajadbot-wa --config ${CONFIG_DIR}/bot.env auth login"
echo "Then run: systemctl start sajadbot-whatsapp"
