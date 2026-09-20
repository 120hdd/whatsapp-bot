import { EventEmitter } from 'node:events';

import { DisconnectReason, type UserFacingSocketConfig, type WASocket } from '@whiskeysockets/baileys';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionManager, type SocketFactory } from '../src/whatsapp/connection-manager.js';
import { makeTestContext, type TestContext } from './helpers/context.js';

function fakeSocket(
  config: UserFacingSocketConfig,
  sequence: number,
): WASocket {
  const events = new EventEmitter();
  const socket = {
    ev: events,
    user: sequence === 2 ? { id: '989121234567:1@s.whatsapp.net', lid: '123456789@lid' } : undefined,
    end: () => undefined,
  } as unknown as WASocket;

  setTimeout(() => {
    if (sequence === 1) {
      config.auth.creds.registered = true;
      events.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
      });
    } else {
      events.emit('connection.update', { connection: 'open' });
    }
  }, 0);

  return socket;
}

describe('ConnectionManager', () => {
  let test: TestContext | undefined;
  afterEach(() => test?.cleanup());

  it('flushes paired credentials and reconnects after protocol restart 515', async () => {
    test = makeTestContext();
    let socketCount = 0;
    const factory: SocketFactory = (config) => fakeSocket(config, ++socketCount);
    const manager = new ConnectionManager(
      test.context.auth,
      test.context.state,
      test.context.audit,
      test.context.config,
      test.context.logger,
      factory,
    );

    await manager.connect({ autoReconnect: false });

    expect(socketCount).toBe(2);
    expect(manager.state).toBe('CONNECTED');
    expect(test.context.auth.hasCredentials()).toBe(true);
    await manager.disconnect();
  });
});
