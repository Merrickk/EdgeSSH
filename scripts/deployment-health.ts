/**
 * 在正式入口验证 GitHub 登录，不跟随跳转、不访问用户资料。
 * Secret 名称齐全不代表运行时可用：必须实际签发 flow Cookie 并读取 D1 工作区。
 */
export async function verifyGithubDeployment(
  hostname: string,
  clientId: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const origin = `https://${hostname}`;
  async function probe(path: string): Promise<Response> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fetcher(`${origin}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        if (attempt === 3) {
          // 不把网络异常的原始内容或带 OAuth state 的响应头写入部署日志。
          throw new Error(`GitHub 登录入口验收无法连接 ${path}（尝试 3 次失败），请检查正式域名的 DNS、证书及网络后重跑 Deploy。`);
        }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    throw new Error(`GitHub 登录入口验收无法连接 ${path}`);
  }
  const login = await probe('/auth/login');
  const location = login.headers.get('Location');
  const target = location && URL.canParse(location, origin) ? new URL(location, origin) : null;
  if (login.status !== 302 || target?.origin !== 'https://github.com'
    || target.pathname !== '/login/oauth/authorize'
    || target.searchParams.get('client_id') !== clientId
    || target.searchParams.get('redirect_uri') !== `${origin}/auth/callback`
    || !login.headers.getSetCookie().some((value) => value.startsWith('__Host-edgessh-oauth='))) {
    throw new Error(`GitHub 登录入口验收失败（/auth/login HTTP ${login.status}）。请检查 Worker 配置与正式入口，修复后重跑 Deploy；不要更换 ENCRYPTION_KEY。`);
  }
  const account = await probe('/api/auth/me');
  // 无 Cookie 的请求必须拒绝授权；500/503 表示数据库或认证状态仍不可用。
  if (account.status !== 401) {
    throw new Error(`GitHub 工作区验收失败（/api/auth/me HTTP ${account.status}）。请检查 D1 迁移与认证方式是否部署完成，再重跑 Deploy。`);
  }
}
