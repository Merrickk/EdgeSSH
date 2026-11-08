import type { Env } from '../types.ts';
import type { AuthProviderType } from './auth-provider.ts';
import { APIError } from './http.ts';

export interface WorkspaceState {
  accountId: string;
  authProvider: AuthProviderType;
  authRevision: number;
  accessNotBefore: number;
  githubAdminId?: string;
  linuxdoAdminId?: string;
}

interface WorkspaceRow {
  account_id: string;
  auth_provider: string;
  auth_revision: number;
  access_not_before: number;
  github_admin_id?: string | null;
  linuxdo_admin_id?: string | null;
}

const validProviders: readonly string[] = ['cloudflare', 'github', 'password', 'linuxdo'];

export async function workspaceState(env: Pick<Env, 'DB'>): Promise<WorkspaceState> {
  const row = await env.DB.prepare(
    'SELECT * FROM workspace_state WHERE id = 1',
  ).first<WorkspaceRow>();
  if (!row || !validProviders.includes(row.auth_provider)) {
    throw new APIError('管理员工作区尚未完成部署初始化。', 503);
  }
  return {
    accountId: row.account_id,
    authProvider: row.auth_provider as AuthProviderType,
    authRevision: row.auth_revision,
    accessNotBefore: row.access_not_before,
    ...(row.github_admin_id ? { githubAdminId: row.github_admin_id } : {}),
    ...(row.linuxdo_admin_id ? { linuxdoAdminId: row.linuxdo_admin_id } : {}),
  };
}

export async function revokeWorkspaceSessions(env: Pick<Env, 'DB'>, state: WorkspaceState): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE workspace_state
     SET auth_revision = auth_revision + 1, access_not_before = ?
     WHERE id = 1 AND auth_provider = ? AND auth_revision = ?`,
  ).bind(Math.floor(Date.now() / 1000) + 1, state.authProvider, state.authRevision).run();
  if (result.meta.changes !== 1) throw new APIError('登录状态已变化，请刷新页面后重试。', 409);
}
