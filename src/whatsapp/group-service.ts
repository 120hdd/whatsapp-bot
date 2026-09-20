import type { WASocket } from '@whiskeysockets/baileys';

import type { DiscoveredDestination } from '../domain/groups.js';
import type { DestinationRepository } from '../db/repositories/index.js';
import { normalizeJid, sameJid } from './jid.js';

export class WhatsAppGroupService {
  public constructor(
    private readonly socketProvider: () => WASocket | null,
    private readonly destinations: DestinationRepository,
  ) {}

  public async refresh(actor = 'cli'): Promise<number> {
    const socket = this.socketProvider();
    if (!socket) throw new Error('WhatsApp is not connected');
    const metadata = await socket.groupFetchAllParticipating();
    const ownJids = [socket.user?.id, socket.user?.lid].filter(
      (value): value is string => Boolean(value),
    );
    const discovered: DiscoveredDestination[] = Object.values(metadata).map((group) => {
      const ownParticipant = group.participants.find((participant) =>
        [participant.id, participant.lid, participant.phoneNumber]
          .filter((value): value is string => Boolean(value))
          .some((participantJid) => ownJids.some((ownJid) => sameJid(participantJid, ownJid))),
      );
      return {
        jid: normalizeJid(group.id),
        subject: group.subject,
        description: group.desc ?? null,
        ownerJid: group.owner ? normalizeJid(group.owner) : null,
        participantCount: group.size ?? group.participants.length,
        addressingMode: group.addressingMode ?? null,
        canSend: !group.announce || ownParticipant?.admin != null,
      };
    });
    return this.destinations.synchronize(discovered, actor);
  }
}
