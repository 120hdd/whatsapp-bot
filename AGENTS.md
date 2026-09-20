# Project decisions

- Runtime: Node.js 20+, ESM TypeScript, exact-pinned Baileys 7 RC.
- Persistence: one SQLite database in WAL mode; numbered transactional migrations.
- Identity: canonical WhatsApp JIDs only. Subjects and aliases are metadata.
- Safety: newly discovered groups are disabled; disabling cancels unsent work; uncertain sends require review.
- Architecture: domain and messaging modules never import Baileys. Only `src/whatsapp` may do so.
- Time: persist UTC ISO-8601 timestamps; CLI schedules must include an explicit offset or `Z`.
- Motion/design rules from the global instructions are not applicable: this is a headless CLI/service.
- Tests must not connect to WhatsApp. Real delivery is never part of automated validation.
