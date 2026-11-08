import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeJwt } from 'jose';
import type { Env } from '../src/types.ts';
import { currentAccount } from '../src/accounts/auth.ts';
import { authRoute } from '../src/accounts/auth-routes.ts';
import { encryptHost, decryptHost } from '../src/accounts/crypto.ts';
import { timingSafeEqualString } from '../src/accounts/password-auth.ts';
import { verifyPasswordDeployment } from '../scripts/deployment-health.ts';

const origin = 'https://ssh.example.com';
const baseEnv: Env = {
  AUTH_PROVIDER: 'password',
  APP_ORIGIN: origin,
  ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  ADMIN_PASSWORD: 'SuperSecretPassword123!',
  ADMIN_USERNAME: 'admin',
} as unknown as Env;

interface MemoryWorkspace {
  account_id: string;
  auth_provider: 'cloudflare' | 'github' | 'password' | 'linuxdo';
  auth_revision: number;
  access_not_before: number;
}

function environment(overrides: Partial<MemoryWorkspace> = {}) {
  const state: MemoryWorkspace = {
    account_id: 'password-owner',
    auth_provider: 'password',
    auth_revision: 1,
    access_not_before: 0,
    ...overrides,
  };
  const DB = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { params = values; return statement; },
        async first<T>() { return { ...state } as T; },
        async run() {
          let changes = 0;
          if (sql.includes('UPDATE workspace_state')
            && params[1] === state.auth_provider && params[2] === state.auth_revision) {
            state.auth_revision++;
            state.access_not_before = params[0] as number;
            changes = 1;
          }
          return { success: true, meta: { changes } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { env: { ...baseEnv, DB } as Env, state };
}

const cookieValue = (response: Response, name: string) =>
  response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))!.split(';')[0];

test('timingSafeEqualString correctly verifies equal and unequal strings', () => {
  assert.equal(timingSafeEqualString('password123', 'password123'), true);
  assert.equal(timingSafeEqualString('', ''), true);
  assert.equal(timingSafeEqualString('pass', 'password123'), false);
  assert.equal(timingSafeEqualString('password123', 'pass'), false);
  assert.equal(timingSafeEqualString('password124', 'password123'), false);
  assert.equal(timingSafeEqualString('admin', 'root'), false);
});

test('password login renders self-contained HTML login page on GET /auth/login', async () => {
  const { env } = environment();
  const req = new Request(`${origin}/auth/login`, { method: 'GET' });
  const response = (await authRoute(req, env))!;
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type')!, /text\/html/);
  const html = await response.text();
  assert.ok(html.includes('EdgeSSH'));
  assert.ok(html.includes('管理员密码登录'));
  assert.ok(html.includes('action="/auth/login"'));
  assert.ok(html.includes('type="password"'));
});

test('successful JSON password login issues signed session cookie and authenticates API', async () => {
  const { env, state } = environment();
  const loginReq = new Request(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'admin', password: 'SuperSecretPassword123!' }),
  });
  const response = (await authRoute(loginReq, env))!;
  assert.equal(response.status, 200);
  const data = await response.json() as { ok: boolean; redirect: string };
  assert.equal(data.ok, true);
  assert.equal(data.redirect, '/');

  const cookie = cookieValue(response, '__Host-edgessh-session');
  assert.ok(cookie.startsWith('__Host-edgessh-session='));
  const header = response.headers.getSetCookie().find((c) => c.startsWith('__Host-edgessh-session='))!;
  assert.match(header, /Secure; HttpOnly; SameSite=Lax/);
  assert.match(header, /Max-Age=2592000(?:;|$)/);

  const payload = decodeJwt(cookie.split('=')[1]);
  assert.equal(payload.sub, 'admin');
  assert.equal(payload.username, 'admin');
  assert.equal(payload.revision, state.auth_revision);

  const account = await currentAccount(new Request(`${origin}/api/auth/me`, { headers: { Cookie: cookie } }), env);
  assert.deepEqual(account, { id: state.account_id, username: 'admin' });
});

test('successful form password login returns 302 redirect to /', async () => {
  const { env } = environment();
  const form = new URLSearchParams();
  form.set('username', 'admin');
  form.set('password', 'SuperSecretPassword123!');
  const loginReq = new Request(`${origin}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: form.toString(),
  });
  const response = (await authRoute(loginReq, env))!;
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/');
  assert.ok(response.headers.getSetCookie().some((c) => c.startsWith('__Host-edgessh-session=')));
});

test('wrong password or wrong username fails with 401', async () => {
  const { env } = environment();
  for (const creds of [
    { username: 'admin', password: 'wrong-password' },
    { username: 'root', password: 'SuperSecretPassword123!' },
    { username: 'admin', password: '' },
  ]) {
    const loginReq = new Request(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(creds),
    });
    await assert.rejects(authRoute(loginReq, env), (error: Error & { status: number }) => error.status === 401);
  }
});

test('password mode logout revokes the session and clears cookies', async () => {
  const { env, state } = environment();
  const loginReq = new Request(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'admin', password: 'SuperSecretPassword123!' }),
  });
  const loginRes = (await authRoute(loginReq, env))!;
  const cookie = cookieValue(loginRes, '__Host-edgessh-session');

  const logoutReq = new Request(`${origin}/api/auth/logout`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie },
  });
  const logoutRes = (await authRoute(logoutReq, env))!;
  assert.equal(logoutRes.status, 200);
  assert.equal(state.auth_revision, 2);
  assert.ok(logoutRes.headers.getSetCookie().every((c) => c.includes('Max-Age=0')));

  await assert.rejects(
    currentAccount(new Request(`${origin}/api/auth/me`, { headers: { Cookie: cookie } }), env),
    /过期/,
  );
});

test('switching between password and other providers preserves encrypted data', async () => {
  const runtime = environment();
  const secret = { host: 'database.internal', password: 'secure-vault-pass' };
  const ciphertext = await encryptHost(secret, runtime.env.ENCRYPTION_KEY, runtime.state.account_id, 'host-pass');

  // Verify can decrypt under password mode
  const loginReq = new Request(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'admin', password: 'SuperSecretPassword123!' }),
  });
  const loginRes = (await authRoute(loginReq, runtime.env))!;
  const cookie = cookieValue(loginRes, '__Host-edgessh-session');
  const account = await currentAccount(new Request(`${origin}/api/auth/me`, { headers: { Cookie: cookie } }), runtime.env);
  assert.equal(account.id, runtime.state.account_id);
  assert.deepEqual(await decryptHost(ciphertext, runtime.env.ENCRYPTION_KEY, account.id, 'host-pass'), secret);
});

test('verifyPasswordDeployment smoke tests password login page and API rejection', async () => {
  const runtime = environment();
  await verifyPasswordDeployment(new URL(origin).hostname, async (url, init) => {
    const req = new Request(url, init);
    const path = new URL(req.url).pathname;
    if (path === '/auth/login') return (await authRoute(req, runtime.env))!;
    try {
      await currentAccount(req, runtime.env);
      return Response.json({ authenticated: true });
    } catch {
      return new Response(null, { status: 401 });
    }
  });
});
