import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';

import type { AuthRepository } from '../db/repositories/index.js';

function serialize(value: unknown): string {
  return JSON.stringify(value, BufferJSON.replacer);
}

function deserialize<T>(value: string): T {
  return JSON.parse(value, BufferJSON.reviver) as T;
}

export interface SQLiteAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

export async function useSQLiteAuthState(repository: AuthRepository): Promise<SQLiteAuthState> {
  const stored = repository.getCredentials();
  const creds: AuthenticationCreds = stored
    ? deserialize<AuthenticationCreds>(stored)
    : initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
        const rows = repository.getKeys(type, ids);
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          const storedValue = rows[id];
          if (!storedValue) continue;
          let value = deserialize<SignalDataTypeMap[T]>(storedValue);
          if (type === 'app-state-sync-key') {
            value = proto.Message.AppStateSyncKeyData.fromObject(
              value as proto.Message.IAppStateSyncKeyData,
            ) as unknown as SignalDataTypeMap[T];
          }
          result[id] = value;
        }
        return result;
      },
      set: async (data): Promise<void> => {
        const updates: Record<string, Record<string, string | null>> = {};
        for (const [category, values] of Object.entries(data)) {
          const serialized: Record<string, string | null> = {};
          for (const [id, value] of Object.entries(values)) {
            serialized[id] = value == null ? null : serialize(value);
          }
          updates[category] = serialized;
        }
        repository.setKeys(updates);
      },
    },
  };
  return {
    state,
    saveCreds: async () => {
      repository.saveCredentials(serialize(creds));
    },
  };
}
