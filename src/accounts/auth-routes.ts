import type { Env } from '../types.ts';
import { authProvider } from './auth-provider.ts';
import { githubCallback, githubLogin } from './github-auth.ts';
import { linuxdoCallback, linuxdoLogin } from './linuxdo-auth.ts';
import { passwordAccount, passwordLogin, renderPasswordLoginPage } from './password-auth.ts';
import { json } from './http.ts';
import { currentAccount } from './auth.ts';
import { revokeWorkspaceSessions, workspaceState } from './workspace.ts';

function clearAllAuthCookies(response: Response): Response {
  response.headers.append('Set-Cookie', '__Host-edgessh-session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
  response.headers.append('Set-Cookie', '__Host-edgessh-oauth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
  return response;
}

export async function authRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!['/auth/login', '/auth/callback', '/api/auth/logout', '/api/auth/login'].includes(path)) return null;
  const provider = authProvider(env);
  if (path === '/api/auth/logout') {
    if (request.method !== 'POST') return json({ error: '请使用 POST 退出登录。' }, 405);
    await currentAccount(request, env);
    const workspace = await workspaceState(env);
    await revokeWorkspaceSessions(env, workspace);
    return clearAllAuthCookies(json({ redirect: provider === 'cloudflare' ? '/cdn-cgi/access/logout' : '/' }));
  }
  if (path === '/api/auth/login') {
    if (request.method !== 'POST') return json({ error: '请使用 POST 登录。' }, 405);
    if (provider !== 'password') return json({ error: '当前未启用密码登录。' }, 404);
    return await passwordLogin(request, env);
  }
  if (path === '/auth/login' && request.method === 'POST') {
    if (provider !== 'password') return json({ error: '当前未启用密码登录。' }, 404);
    return await passwordLogin(request, env);
  }
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (provider === 'password') {
    if (path === '/auth/login') {
      try {
        const workspace = await workspaceState(env);
        await passwordAccount(request, env, workspace.authRevision);
        return new Response(null, { status: 302, headers: { Location: '/', 'Cache-Control': 'no-store' } });
      } catch {
        return renderPasswordLoginPage();
      }
    }
    return json({ error: '当前未启用第三方 OAuth 回调。' }, 404);
  }
  if (provider === 'linuxdo') {
    return path === '/auth/login' ? await linuxdoLogin(request, env) : await linuxdoCallback(request, env);
  }
  if (provider === 'github') {
    return path === '/auth/login' ? await githubLogin(request, env) : await githubCallback(request, env);
  }
  // Cloudflare 模式不接受第三方回调或会话；登录入口由域名前的 Access 网关处理。
  return path === '/auth/login' ? new Response(null, { status: 302, headers: { Location: '/', 'Cache-Control': 'no-store' } })
    : json({ error: '当前未启用第三方 OAuth 回调。' }, 404);
}
