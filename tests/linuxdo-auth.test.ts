import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64url, decodeJwt } from 'jose';
import type { Env } from '../src/types.ts';
import { currentAccount } from '../src/accounts/auth.ts';
import { authRoute } from '../src/accounts/auth-routes.ts';
import { linuxdoCallback, linuxdoLogin } from '../src/accounts/linuxdo-auth.ts';
import { verifyLinuxDoDeployment } from '../scripts/deployment-health.ts';

const origin = 'https://ssh.example.com';
const baseEnv: Env = {
  AUTH_PROVIDER: 'linuxdo',
  APP_ORIGIN: origin,
  ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  LINUXDO_CLIENT_ID: 'test-linuxdo-client',
  LINUXDO_CLIENT_SECRET: 'test-linuxdo-secret',
  LINUXDO_ADMIN_ID: '8888',
} as unknown as Env;

interface MemoryWorkspace {
  account_id: string;
  auth_provider: 'cloudflare' | 'github' | 'password' | 'linuxdo';
  auth_revision: number;
  access_not_before: number;
  linuxdo_admin_id?: string;
}

function environment(overrides: Partial<MemoryWorkspace> = {}) {
  const state: MemoryWorkspace = {
    account_id: 'linuxdo-owner',
    auth_provider: 'linuxdo',
    auth_revision: 1,
    access_not_before: 0,
    linuxdo_admin_id: '8888',
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

const request = (path: string, cookie = '', headers = {}) => new Request(`${origin}${path}`, {
  headers: { Cookie: cookie, ...headers },
});

async function start(target = environment().env) {
  const response = await linuxdoLogin(request('/auth/login'), target);
  const authorization = new URL(response.headers.get('Location')!);
  return { response, authorization, cookie: cookieValue(response, '__Host-edgessh-oauth') };
}

function exchange(id = 8888): typeof fetch {
  return async (url, init) => {
    if (String(url).endsWith('/oauth2/token')) {
      assert.equal(init?.method, 'POST');
      const body = init?.body as URLSearchParams;
      assert.equal(body.get('client_secret'), baseEnv.LINUXDO_CLIENT_SECRET);
      assert.equal(body.get('redirect_uri'), `${origin}/auth/callback`);
      assert.equal(body.get('code_verifier')?.length, 43);
      return Response.json({ access_token: 'private-linuxdo-token' });
    }
    assert.equal(String(url), 'https://connect.linux.do/api/user');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer private-linuxdo-token');
    return Response.json({ id, username: 'linuxdo-admin' });
  };
}

async function login(target = environment().env) {
  const flow = await start(target);
  const response = await linuxdoCallback(
    request(`/auth/callback?code=valid&state=${flow.authorization.searchParams.get('state')}`, flow.cookie),
    target,
    exchange(),
  );
  assert.equal(response.status, 302);
  return { response, cookie: cookieValue(response, '__Host-edgessh-session') };
}

test('LINUX DO OAuth starts with random state, S256 PKCE and connect.linux.do authorize endpoint', async () => {
  const first = await start();
  assert.equal(first.authorization.origin, 'https://connect.linux.do');
  assert.equal(first.authorization.pathname, '/oauth2/authorize');
  assert.equal(first.authorization.searchParams.get('redirect_uri'), `${origin}/auth/callback`);
  assert.equal(first.authorization.searchParams.get('code_challenge_method'), 'S256');
  const payload = decodeJwt(first.cookie.split('=')[1]);
  const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(payload.verifier)))));
  assert.equal(challenge, first.authorization.searchParams.get('code_challenge'));
});

test('only the configured LINUX DO administrator receives a revision-bound session', async () => {
  const { env, state } = environment();
  const flow = await start(env);
  const denied = await linuxdoCallback(
    request(`/auth/callback?code=valid&state=${flow.authorization.searchParams.get('state')}`, flow.cookie),
    env,
    exchange(9999),
  );
  assert.equal(denied.status, 403);

  const { response, cookie } = await login(env);
  assert.equal(response.headers.get('Location'), '/');
  const account = await currentAccount(request('/api/auth/me', cookie), env);
  assert.deepEqual(account, { id: state.account_id, username: 'linuxdo-admin' });
});

test('verifyLinuxDoDeployment smoke tests authorize URL and API rejection', async () => {
  const { env } = environment();
  await verifyLinuxDoDeployment(new URL(origin).hostname, baseEnv.LINUXDO_CLIENT_ID!, async (url, init) => {
    const req = new Request(url, init);
    const path = new URL(req.url).pathname;
    if (path === '/auth/login') return (await authRoute(req, env))!;
    try {
      await currentAccount(req, env);
      return Response.json({ authenticated: true });
    } catch {
      return new Response(null, { status: 401 });
    }
  });
});
