import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseConnectMessage } from '../src/types.ts';

const result = await build({
  stdin: {
    contents: "export * from './src/backend/tunnel-socket.ts';",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
});
const { wrapWebSocketAsSocket } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

test('parseConnectMessage parses Cloudflare Tunnel configuration', () => {
  const raw = {
    type: 'connect',
    host: 'ssh-tunnel.example.com',
    port: 22,
    username: 'root',
    authMethod: 'password',
    password: 'secret',
    cfTunnel: true,
    cfAccessClientId: 'client-id-123',
    cfAccessClientSecret: 'client-secret-456',
  };

  const parsed = parseConnectMessage(raw);
  assert.equal(parsed.cfTunnel, true);
  assert.equal(parsed.cfAccessClientId, 'client-id-123');
  assert.equal(parsed.cfAccessClientSecret, 'client-secret-456');
});

test('parseConnectMessage defaults cfTunnel to undefined when omitted', () => {
  const raw = {
    type: 'connect',
    host: 'example.com',
    port: 22,
    username: 'root',
    authMethod: 'password',
    password: 'secret',
  };

  const parsed = parseConnectMessage(raw);
  assert.equal(parsed.cfTunnel, undefined);
  assert.equal(parsed.cfAccessClientId, undefined);
  assert.equal(parsed.cfAccessClientSecret, undefined);
});

test('wrapWebSocketAsSocket sets binaryType and delivers ArrayBuffer and Blob events', async () => {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const sentData: any[] = [];
  const fakeWs: any = {
    readyState: 1, // WebSocket.OPEN
    binaryType: 'blob',
    addEventListener(event: string, fn: (...args: any[]) => void) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn);
    },
    send(data: any) {
      sentData.push(data);
    },
    close() {},
  };

  const socket = wrapWebSocketAsSocket(fakeWs as WebSocket, 'test:443');
  assert.equal(fakeWs.binaryType, 'arraybuffer', 'sets binaryType to arraybuffer');

  const reader = socket.readable.getReader();

  // Test sync ArrayBuffer message
  const msg1 = new Uint8Array([1, 2, 3]).buffer;
  for (const fn of listeners.message || []) {
    fn({ data: msg1 });
  }
  const chunk1 = await reader.read();
  assert.deepEqual(Array.from(chunk1.value!), [1, 2, 3]);

  // Test Blob message fallback
  const blob = new Blob([new Uint8Array([4, 5, 6])]);
  for (const fn of listeners.message || []) {
    fn({ data: blob });
  }
  const chunk2 = await reader.read();
  assert.deepEqual(Array.from(chunk2.value!), [4, 5, 6]);

  // Test writable
  const writer = socket.writable.getWriter();
  await writer.write(new Uint8Array([7, 8, 9]));
  assert.equal(sentData.length, 1);
  assert.deepEqual(Array.from(sentData[0]), [7, 8, 9]);

  reader.releaseLock();
  writer.releaseLock();
  await socket.close();
});
