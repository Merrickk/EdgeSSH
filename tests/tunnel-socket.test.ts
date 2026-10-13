import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConnectMessage } from '../src/types.ts';

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
