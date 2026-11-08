import type { Env } from '../types.ts';
import { APIError } from './http.ts';

export type AuthProviderType = 'cloudflare' | 'github' | 'password' | 'linuxdo';

export function authProvider(env: Pick<Env, 'AUTH_PROVIDER'>): AuthProviderType {
  const provider = (env.AUTH_PROVIDER || 'cloudflare') as AuthProviderType;
  if (!['cloudflare', 'github', 'password', 'linuxdo'].includes(provider)) {
    throw new APIError('管理员尚未正确配置登录方式。', 503);
  }
  return provider;
}
