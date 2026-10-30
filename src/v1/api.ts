import { decodeProject, normalizeAsset } from './model';
import type { Asset, Category, Capabilities, Project, Style, Summary, Task } from './model';
export class ApiError extends Error { status: number; code: string; constructor(message: string, status: number, code: string) { super(message); this.status = status; this.code = code; } }
export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (import.meta.env?.VITE_DEMO === 'true') return (await import('./demo')).demoRequest<T>(path, method, body);
  let response: Response;
  try { response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) }); }
  catch { throw new ApiError('连接中断，请重试', 0, 'NETWORK'); }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    if (response.status === 401 && !path.startsWith('/auth/') && path !== '/me') window.dispatchEvent(new Event('jingliu:unauthorized'));
    const message = payload?.error?.code === 'QUOTA_EXCEEDED' ? '可用额度不足' : payload?.error?.message || '服务暂不可用';
    throw new ApiError(message, response.status, payload?.error?.code || 'SERVICE');
  }
  return payload as T;
}
export const api = {
  me: () => request<{ user: { id: string; name: string; role?: string }; quota: { budget: number; used: number } }>('/me'),
  login: (inviteToken: string, name: string) => request('/auth/accept-invite', 'POST', { inviteToken, name }),
  adminStatus: () => request<{ configured: boolean }>('/auth/admin-status'),
  adminLogin: (password: string) => request('/auth/admin-login', 'POST', { password }),
  adminSetup: (setupToken: string, password: string) => request('/auth/admin-setup', 'POST', { setupToken, password }),
  invite: () => request<{ inviteToken: string }>('/admin/invite', 'POST', {}),
  logout: () => request('/auth/logout', 'POST', {}),
  projects: async () => (await request<{ projects: Summary[] }>('/projects')).projects,
  project: async (id: string) => decodeProject((await request<{ project: Project }>(`/projects/${encodeURIComponent(id)}`)).project),
  create: async () => decodeProject((await request<{ project: Project }>('/projects', 'POST', { name: '未命名项目' })).project),
  save: async (p: Project) => decodeProject((await request<{ project: Project }>(`/projects/${encodeURIComponent(p.id)}`, 'PUT', { expectedRevision: p.revision, name: p.name, nodes: p.nodes.map(({ id, data, position }) => ({ id, position, ...data })), referenceEdges: p.referenceEdges, viewport: p.viewport })).project),
  capabilities: () => request<Capabilities>('/capabilities'),
  styles: async () => (await request<{ styles: Style[] }>('/styles')).styles,
  assets: async (id: string) => {
    const [project, library] = await Promise.all([request<{ assets: Asset[] }>(`/assets?projectId=${encodeURIComponent(id)}`), request<{ assets: Asset[] }>('/library/assets?type=upload')]);
    return [...new Map([...project.assets, ...library.assets].map(a => [a.id, normalizeAsset(a)])).values()];
  },
  categories: async () => (await request<{ categories: Category[] }>('/categories')).categories,
  createCategory: async (name: string) => (await request<{ category: Category }>('/categories', 'POST', { name })).category,
  renameCategory: async (id: string, name: string) => (await request<{ category: Category }>(`/categories/${encodeURIComponent(id)}`, 'PATCH', { name })).category,
  moveAsset: async (id: string, categoryId: string | null) => normalizeAsset((await request<{ assetVersion: Asset }>(`/assets/${encodeURIComponent(id)}/category`, 'PATCH', { categoryId })).assetVersion),
  deleteCategory: (id: string) => request(`/categories/${encodeURIComponent(id)}`, 'DELETE'),
  tasks: async (id: string) => (await request<{ tasks: Task[] }>(`/tasks?projectId=${encodeURIComponent(id)}`)).tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  generate: async (body: unknown) => (await request<{ task: Task }>('/generations', 'POST', body)).task,
  action: async (id: string, action: string, actionId: string) => (await request<{ task: Task }>(`/tasks/${encodeURIComponent(id)}/actions`, 'POST', { action, actionId })).task,
  upload: async (body: unknown) => normalizeAsset((await request<{ assetVersion: Asset }>('/assets', 'POST', body)).assetVersion),
};
