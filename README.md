# SajadBot WhatsApp

SajadBot WhatsApp is a conservative, single-account WhatsApp linked-device service for operator-approved group messaging. It provides a durable SQLite queue, explicit scheduling, bounded retries, content-based idempotency, crash-uncertainty quarantine, media staging, a group allowlist, an operational CLI, structured logs, and a hardened systemd deployment.

This project uses the current Baileys 7 API and WhatsApp Web linked-device behavior. **Baileys is unofficial and is not the WhatsApp Business/Cloud API.** WhatsApp may change its protocol or enforce account restrictions without notice. Use this only for legitimate, controlled communication to destinations you administer. It does not promise account safety and contains no scraping, anti-ban, restriction-bypass, or bulk-DM features.

## Architecture and safety model

```text
CLI / optional verified self-chat commands
                  │
           MessageService
                  │
     SQLite WAL durable queue + audit
        │         │          │
    schedule   bounded retry  recovery
        └─────────┼──────────┘
                  │
             QueueWorker
                  │ MessageTransport
       ┌──────────┼──────────┐
   DryRun      Fake(test)   Baileys
                              │
                   WhatsApp linked device
```

The domain, queue, scheduler, idempotency, and persistence layers do not import Baileys. `BaileysTransport` alone translates application intent to `sendMessage()` payloads. Dry-run substitutes a dedicated transport and never constructs a WhatsApp socket.

Key invariants:

- Canonical JIDs—not phone numbers or mutable group subjects—identify destinations.
- Newly discovered groups are disabled. Only an explicit `groups allow` makes one sendable.
- Disabling a group transactionally cancels its pending, scheduled, retrying, and rate-limited jobs.
- Job claims use `BEGIN IMMEDIATE` and a compare-and-update guard.
- A process crash while a job is `PROCESSING` has an uncertain delivery outcome. Startup moves it to `REVIEW_REQUIRED`; it is never automatically resent.
- Idempotency uses destination, normalized content, staged content hash, schedule identity, payload type, and relevant options. Original media paths are not identity.
- Auth failures pause processing without reporting delivery. Logged-out state does not reconnect forever.
- Message bodies and Signal credentials are excluded from normal logs and audit details.

The implementation was modeled after `120hdd/telethon-Bot` `main` commit `e5995689764ffc635fdb76652a7ad76439034c48`, preserving its queue, allowlist, duplicate-suppression, recovery, audit, locking, and operator-control semantics while adapting identity and mutable auth state for WhatsApp.

## Requirements

- Linux for production (Ubuntu with systemd is the supported deployment target)
- Node.js 20 or newer
- npm
- A WhatsApp account that can link a companion device
- Build tools may be required if a prebuilt `better-sqlite3` binary is unavailable

Baileys is exact-pinned to `7.0.0-rc14` because the 7.x line can contain breaking RC changes. Review release and security notes before changing that pin.

## Local installation and validation

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Copy the example and adjust paths and timezone:

```bash
cp .env.example .env
npm run dev -- status
```

Configuration is validated with Zod and invalid values fail fast. Timestamps are stored as UTC ISO-8601. `schedule --at` rejects timestamps without `Z` or an explicit offset; `TIMEZONE` controls human-facing display only.

| Setting | Default | Purpose |
|---|---:|---|
| `DATABASE_PATH` | `./data/app.db` | Queue, audit, group cache, and encrypted-protocol auth material |
| `STATE_DIR` | `./data` | Private runtime state root |
| `MEDIA_DIR` | `./data/media` | Content-addressed staged media |
| `LOCK_PATH` | `./data/daemon.lock` | Single-daemon lock |
| `LOG_LEVEL` | `info` | Pino log level |
| `TIMEZONE` | `UTC` | CLI display timezone |
| `DRY_RUN` | `false` | Use the no-network delivery transport |
| `WORKER_POLL_MS` | `1000` | Idle queue polling interval |
| `SEND_INTERVAL_MS` | `8000` | Conservative minimum pacing between sends |
| `MAX_ATTEMPTS` | `5` | Persisted delivery attempt ceiling |
| `RETRY_BASE_MS` | `5000` | Exponential backoff base |
| `RETRY_MAX_MS` | `300000` | Backoff cap |
| `MAX_MEDIA_BYTES` | `2147483648` | Media validation ceiling |
| `SELF_CONTROLLER_ENABLED` | `false` | Enable the optional Message Yourself controller |
| `PAIRING_PHONE` | empty | Optional digits-with-country-code pairing login |

## First login

QR login is the default:

```bash
npm run dev -- auth login
```

In the WhatsApp mobile app, open Linked devices and scan the displayed QR. Pairing-code login is also available:

```bash
npm run dev -- auth login --pairing-phone 989121234567
```

Auth is not a static token. Baileys credentials and Signal keys continuously mutate and are stored transactionally in SQLite using Baileys `BufferJSON` serialization. Protect the database like a password.

```bash
npm run dev -- auth status
npm run dev -- auth logout
# Emergency local removal when server logout cannot be reached:
npm run dev -- auth logout --local-only
```

Ordinary disconnects never delete credentials. Logout is an explicit command.

## Group discovery and allowlisting

```bash
npm run dev -- groups refresh
npm run dev -- groups list
npm run dev -- groups show 120363000000000000@g.us
npm run dev -- groups alias 120363000000000000@g.us operations
npm run dev -- groups allow operations
npm run dev -- groups deny operations
npm run dev -- groups unalias operations
```

Refresh updates metadata in one transaction and preserves the previous cache if the network call fails. Renaming a WhatsApp group does not change its JID, alias, or allowlist status.

`groups import-local` exists for offline dry-run preparation. It seeds only a disabled `@g.us` identity and never discovers or joins a group:

```bash
npm run dev -- groups import-local 120363000000000000@g.us --subject "Dry run" --alias dry-run-test
npm run dev -- groups allow dry-run-test
```

## Sending and scheduling

The service queues work; the daemon performs real delivery.

```bash
npm run dev -- send operations --text "Deployment complete"
npm run dev -- send operations --file ./photo.jpg --caption "Site photo"
npm run dev -- send operations --file ./report.pdf --caption "Report" --filename report.pdf

npm run dev -- schedule operations \
  --at "2026-09-21T12:30:00+03:30" \
  --text "Scheduled update"
```

Supported intents are text, image, video, document, and audio. Audio captioning is not used because it is not reliably represented as one WhatsApp audio message. Media is hashed and copied to application-managed storage before the job is created. Source files may then be moved or deleted.

Submitting an active or already delivered equivalent request returns the existing job. Use `--force` only for an intentional duplicate.

## Queue and recovery

```bash
npm run dev -- queue list
npm run dev -- queue show JOB_UUID
npm run dev -- queue show JOB_UUID --include-content
npm run dev -- queue pending
npm run dev -- queue failed
npm run dev -- queue review
npm run dev -- queue cancel JOB_UUID
npm run dev -- queue retry JOB_UUID
npm run dev -- queue mark-sent JOB_UUID
```

`queue retry` is deliberately manual for `FAILED` and `REVIEW_REQUIRED` jobs and resets their attempt budget. For an uncertain job, investigate WhatsApp first:

- If it was delivered, use `queue mark-sent`.
- If it definitely was not delivered, use `queue retry`.
- If it should not be sent, use `queue cancel`.

Do not blindly retry uncertain work; that can create a duplicate.

Job states are `PENDING`, `SCHEDULED`, `PROCESSING`, `WAITING_RATE_LIMIT`, `RETRY`, `SENT`, `FAILED`, `CANCELLED`, `REVIEW_REQUIRED`, and `DRY_RUN`. Illegal transitions are rejected in the domain layer.

## Dry-run

Dry-run is a complete offline pipeline, not a print-only flag:

```bash
npm run dev -- --dry-run send dry-run-test --text "SajadBot WhatsApp dry-run test"
npm run dev -- --dry-run send dry-run-test --file ./tests/fixtures/image.jpg --caption "media dry-run"
```

Validation, allowlist resolution, media staging, hashing, idempotency, queue claiming, state transitions, audit, and logging all run. The terminal state is `DRY_RUN` with an unmistakable `dryrun:<job-id>` non-real identifier. No Baileys socket is required or constructed. Scheduled dry-runs are processed by a daemon started with `DRY_RUN=true` when they become due.

Run the reproducible smoke checks:

```bash
npm run smoke:dry-run
npm run smoke:recovery
npm run smoke:retry
```

## Optional Message Yourself controller

Set `SELF_CONTROLLER_ENABLED=true` only if desired. CLI remains authoritative. Supported commands are `/status`, `/queue [failed]`, `/groups [refresh]`, `/send`, `/schedule`, and `/cancel`.

Commands are accepted only for a current `notify` event that is `fromMe`, targets the authenticated account's verified PN JID or LID self-chat, has a matching participant when present, is not forwarded, is not historical, and has not been processed before. Processed IDs are persistent. Groups, arbitrary DMs, replayed history, forwarded commands, and identity mismatches are ignored.

## Status, audit, and logs

```bash
npm run dev -- status
npm run dev -- health
npm run dev -- audit --limit 100
```

`health` never sends a message and returns non-zero for fatal/auth-required conditions unless offline dry-run is active. It reports the connection and auth states, queue counts, oldest pending time, review/failed counts, last send/connection, worker state, journal mode, and dry-run state.

Logs are newline-delimited Pino JSON suitable for journald. Useful context includes `job_id`, `destination_jid`, `attempt`, `error_class`, and `connection_state`. Credential/key fields are redacted. View production logs with:

```bash
journalctl -u sajadbot-whatsapp -f
```

## Ubuntu/systemd production setup

Build and install from a reviewed checkout:

```bash
git clone <YOUR_REPOSITORY_URL> sajadbot-whatsapp
cd sajadbot-whatsapp
npm ci
npm run typecheck
npm run lint
npm test
npm run build
sudo bash scripts/install.sh
```

Authenticate and configure groups as the dedicated account:

```bash
sudoedit /etc/sajadbot-whatsapp/bot.env
sudo -u sajadbot-wa sajadbot-wa --config /etc/sajadbot-whatsapp/bot.env auth login
sudo -u sajadbot-wa sajadbot-wa --config /etc/sajadbot-whatsapp/bot.env groups refresh
sudo -u sajadbot-wa sajadbot-wa --config /etc/sajadbot-whatsapp/bot.env groups list
sudo -u sajadbot-wa sajadbot-wa --config /etc/sajadbot-whatsapp/bot.env groups alias GROUP_JID operations
sudo -u sajadbot-wa sajadbot-wa --config /etc/sajadbot-whatsapp/bot.env groups allow operations
sudo systemctl start sajadbot-whatsapp
sudo systemctl status sajadbot-whatsapp
```

The layout is:

- `/opt/sajadbot-whatsapp`: immutable application and production dependencies
- `/etc/sajadbot-whatsapp/bot.env`: root-owned configuration, readable by the service group
- `/var/lib/sajadbot-whatsapp`: mode-0700 database, auth state, lock, and staged media
- `/var/log/sajadbot-whatsapp`: reserved private log path; the default service logs to journald

The unit uses a dedicated `sajadbot-wa` system account, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `NoNewPrivileges=true`, an empty capability set, restricted address families, and write access only to state/log directories. When auth is absent the daemon exits successfully, so `Restart=on-failure` does not create an auth-required restart storm.

Operational commands:

```bash
sudo systemctl start sajadbot-whatsapp
sudo systemctl stop sajadbot-whatsapp
sudo systemctl restart sajadbot-whatsapp
sudo systemctl status sajadbot-whatsapp
sudo journalctl -u sajadbot-whatsapp --since today

# From a new reviewed/build-tested checkout:
sudo bash scripts/upgrade.sh

# Preserves database, auth, media, config, and logs:
sudo bash scripts/uninstall.sh

# Permanently deletes those sensitive assets as well:
sudo bash scripts/uninstall.sh --purge
```

## Backup and restore

Back up these together while the service is stopped, or use SQLite's online backup mechanism:

- `/var/lib/sajadbot-whatsapp/app.db` (queue, audit, group cache, and WhatsApp auth state)
- `/var/lib/sajadbot-whatsapp/media` (files needed by unsent jobs)
- `/etc/sajadbot-whatsapp/bot.env`

SQLite `-wal` and `-shm` files can contain committed state while the service runs; copying only `app.db` from a live service is unsafe. Backups containing auth state grant account access and must be encrypted, access-controlled, and never uploaded automatically. Restore ownership to `sajadbot-wa:sajadbot-wa` and mode `0600`/`0700` before starting.

## Troubleshooting

- `AUTH_REQUIRED` / `LOGGED_OUT`: stop the service, run `auth login`, then start it. Queued jobs remain persisted.
- `REVIEW_REQUIRED`: inspect WhatsApp and resolve with `mark-sent`, `retry`, or `cancel`.
- Unknown group: run `groups refresh`; then assign an alias and explicitly allow it.
- Disabled or unsendable group: verify membership/admin restrictions. A permanent permission/destination failure marks the cache unsendable and requires a successful refresh/operator review.
- Database locked or second daemon: check `systemctl status`; the PID-aware lock is not deleted while its process is alive.
- QR does not appear: ensure `auth login` runs interactively, not inside the daemon.
- Media missing: restore the staged content from backup; the worker will fail safely rather than use the original source path.
- Protocol breakage: review the exact Baileys release notes and migration guide before updating the pinned dependency.

## Security and remaining limitations

- The SQLite database contains highly sensitive linked-device material. File permissions and backups are part of the security boundary.
- This is intentionally one account and one daemon. Multi-account architecture, a web panel, Redis, RabbitMQ, REST APIs, member harvesting, joining automation, and contact discovery are out of scope.
- WhatsApp delivery acknowledgment cannot make a process crash between remote acceptance and local commit exactly-once. `REVIEW_REQUIRED` makes this ambiguity explicit and prevents automatic duplicates.
- Group permission metadata can become stale between refreshes; a send-time permanent error safely fails and disables sending for that destination.
- Baileys 7 is currently an RC. Production upgrades require review and the complete offline test/smoke gate.
