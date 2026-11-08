import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { Env } from '../types.ts';
import { APIError } from './http.ts';
import { secureResponse } from '../http-security.ts';
import { workspaceState } from './workspace.ts';
import { encryptionKeyBytes } from './crypto.ts';

const sessionCookie = '__Host-edgessh-session';
const sessionSeconds = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();

export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  const maxLen = Math.max(bufA.byteLength, bufB.byteLength);
  let diff = bufA.byteLength ^ bufB.byteLength;
  for (let i = 0; i < maxLen; i++) {
    const byteA = i < bufA.byteLength ? bufA[i] : 0;
    const byteB = i < bufB.byteLength ? bufB[i] : 0;
    diff |= byteA ^ byteB;
  }
  return diff === 0;
}

function cookie(request: Request, name: string): string | undefined {
  return request.headers.get('Cookie')?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

async function signingKey(secret: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', encryptionKeyBytes(secret), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('edgessh:v1'),
    info: encoder.encode('password-session-cookie'),
  }, material, 256));
}

function audience(): string {
  return 'edgessh:session:password:admin';
}

async function sign(origin: string, secret: string, payload: JWTPayload, seconds: number): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuer(origin)
    .setAudience(audience()).setIssuedAt().setExpirationTime(`${seconds}s`)
    .sign(await signingKey(secret));
}

async function verify(origin: string, secret: string, token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, await signingKey(secret), {
    issuer: origin, audience: audience(), algorithms: ['HS256'], requiredClaims: ['exp', 'iat'],
  });
  return payload;
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m] || m));
}

export function renderPasswordLoginPage(options?: { error?: string; username?: string }): Response {
  const errorHtml = options?.error
    ? `<div class="login-alert" role="alert">${escapeHtml(options.error)}</div>`
    : '';
  const usernameVal = escapeHtml(options?.username ?? 'admin');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EdgeSSH - 管理员登录</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #090d16;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .login-container {
      width: 100%;
      max-width: 400px;
      background: #111827;
      border: 1px solid #1f293d;
      border-radius: 14px;
      padding: 2.25rem 2rem;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
    }
    .login-header {
      text-align: center;
      margin-bottom: 2rem;
    }
    .login-icon {
      width: 52px;
      height: 52px;
      margin: 0 auto 1rem;
      background: linear-gradient(135deg, #ea580c, #f97316);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ffffff;
      font-weight: 700;
      font-size: 22px;
      letter-spacing: -0.5px;
      box-shadow: 0 4px 14px rgba(249, 115, 22, 0.35);
    }
    .login-title {
      font-size: 1.5rem;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -0.025em;
      margin-bottom: 0.35rem;
    }
    .login-subtitle {
      font-size: 0.875rem;
      color: #94a3b8;
    }
    .login-alert {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.35);
      color: #fca5a5;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-size: 0.875rem;
      margin-bottom: 1.25rem;
      text-align: center;
    }
    .form-group {
      margin-bottom: 1.25rem;
    }
    .form-label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 600;
      color: #cbd5e1;
      margin-bottom: 0.4rem;
    }
    .form-input {
      width: 100%;
      background: #0b1120;
      border: 1px solid #27354f;
      border-radius: 8px;
      padding: 0.7rem 0.9rem;
      color: #f8fafc;
      font-size: 0.9375rem;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .form-input:focus {
      border-color: #f97316;
      box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.2);
    }
    .login-btn {
      width: 100%;
      background: #f97316;
      color: #ffffff;
      border: none;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      font-size: 0.9375rem;
      font-weight: 600;
      cursor: pointer;
      margin-top: 0.5rem;
      transition: background-color 0.15s ease, transform 0.05s ease;
    }
    .login-btn:hover {
      background: #ea580c;
    }
    .login-btn:active {
      transform: scale(0.99);
    }
    .login-footer {
      margin-top: 1.75rem;
      text-align: center;
      font-size: 0.75rem;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-header">
      <div class="login-icon">&gt;_</div>
      <h1 class="login-title">EdgeSSH</h1>
      <p class="login-subtitle">管理员密码登录</p>
    </div>
    ${errorHtml}
    <form action="/auth/login" method="POST" autocomplete="on">
      <div class="form-group">
        <label class="form-label" for="username">管理员账号</label>
        <input class="form-input" id="username" type="text" name="username" value="${usernameVal}" required autofocus autocomplete="username" />
      </div>
      <div class="form-group">
        <label class="form-label" for="password">管理员密码</label>
        <input class="form-input" id="password" type="password" name="password" required placeholder="请输入管理员密码" autocomplete="current-password" />
      </div>
      <button class="login-btn" type="submit">登 录</button>
    </form>
    <div class="login-footer">EdgeSSH · 云原生轻量级 SSH 终端</div>
  </div>
</body>
</html>`;

  return secureResponse(new Response(html, {
    status: options?.error ? 401 : 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  }));
}

export async function passwordLogin(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_PASSWORD) {
    throw new APIError('管理员尚未配置 ADMIN_PASSWORD，请在 Worker Secret 中配置。', 503);
  }
  if (!env.ENCRYPTION_KEY) {
    throw new APIError('管理员尚未配置 ENCRYPTION_KEY。', 503);
  }

  const origin = new URL(request.url).origin;
  const isJson = request.headers.get('Content-Type')?.includes('application/json');
  let username = 'admin';
  let password = '';

  if (isJson) {
    try {
      const body = await request.json() as { username?: string; password?: string };
      username = body.username?.trim() || 'admin';
      password = body.password || '';
    } catch {
      throw new APIError('登录请求格式不正确。', 400);
    }
  } else {
    try {
      const formData = await request.formData();
      username = (formData.get('username') as string)?.trim() || 'admin';
      password = (formData.get('password') as string) || '';
    } catch {
      throw new APIError('登录表单解析失败。', 400);
    }
  }

  // 短暂延时缓解暴力破解与计时旁路
  await new Promise((r) => setTimeout(r, 200));

  const expectedUsername = env.ADMIN_USERNAME?.trim() || 'admin';
  const expectedPassword = env.ADMIN_PASSWORD.trim();

  const userMatches = timingSafeEqualString(username, expectedUsername);
  const passwordMatches = timingSafeEqualString(password, expectedPassword);

  if (!userMatches || !passwordMatches) {
    if (isJson) {
      throw new APIError('用户名或密码错误。', 401);
    }
    return renderPasswordLoginPage({ error: '用户名或密码错误。', username });
  }

  const workspace = await workspaceState(env);
  const session = await sign(origin, env.ENCRYPTION_KEY, {
    sub: 'admin',
    username: expectedUsername,
    revision: workspace.authRevision,
  }, sessionSeconds);

  const cookieHeader = setCookie(sessionCookie, session, sessionSeconds);

  if (isJson) {
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', cookieHeader);
    return secureResponse(new Response(JSON.stringify({ ok: true, redirect: '/' }), { status: 200, headers }));
  }

  const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookieHeader);
  return secureResponse(new Response(null, { status: 302, headers }));
}

export async function passwordAccount(request: Request, env: Env, authRevision: number): Promise<{ username: string }> {
  if (!env.ADMIN_PASSWORD) {
    throw new APIError('管理员尚未配置密码登录。', 503);
  }
  const token = cookie(request, sessionCookie);
  if (!token) throw new APIError('请先使用密码登录。', 401);
  const origin = new URL(request.url).origin;
  try {
    const payload = await verify(origin, env.ENCRYPTION_KEY, token);
    if (payload.sub !== 'admin' || typeof payload.username !== 'string' || payload.revision !== authRevision) {
      throw new Error('Invalid session');
    }
    return { username: payload.username };
  } catch {
    throw new APIError('登录已过期，请重新登录。', 401);
  }
}

export function clearPasswordCookies(response: Response): Response {
  response.headers.append('Set-Cookie', setCookie(sessionCookie, '', 0));
  return response;
}
