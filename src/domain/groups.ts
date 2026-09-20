export interface Destination {
  jid: string;
  subject: string;
  description: string | null;
  ownerJid: string | null;
  participantCount: number | null;
  addressingMode: string | null;
  alias: string | null;
  enabled: boolean;
  canSend: boolean;
  createdAt: string;
  updatedAt: string;
  lastRefreshedAt: string;
}

export interface DiscoveredDestination {
  jid: string;
  subject: string;
  description?: string | null;
  ownerJid?: string | null;
  participantCount?: number | null;
  addressingMode?: string | null;
  canSend?: boolean;
}
