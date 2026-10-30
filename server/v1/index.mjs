// 镜流 B1/B2：v1 HTTP 路由层
// 提供 /api/v1/* 接口，实现邀请认证、项目 CRUD、多参考素材、任务只读、能力/风格声明、生成（B2 幂等 + 费用估算）。

import http from 'node:http';
import { ApiError } from './store.mjs';
import { CAPABILITIES, STYLES } from './capabilities.mjs';
import { GenerationCoordinator } from './generation.mjs';

import { AdminAuth } from './admin.mjs';

const COOKIE = 'jingliu_session';

async function readBody(req, limit = 24 * 1024 * 1024) {
  let chunks = [], length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new ApiError('LARGE', '请求体超过上限。', 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new ApiError('INPUT', '请求格式错误。'); }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function createV1Server({ store, coordinator = null, originWhitelist = null }) {
  const adminAuth = new AdminAuth(store);
  const gen = coordinator || new GenerationCoordinator(store);
  const server = http.createServer(async (req, res) => {
    const setCookie = (token, maxAge) => {
      res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
    };
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (originWhitelist && req.headers.origin && !originWhitelist.includes(req.headers.origin)) {
        throw new ApiError('FORBIDDEN', '不允许跨站访问。', 403);
      }
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
        const allowed = originWhitelist || ['http://127.0.0.1:5194', 'http://localhost:5194', 'http://127.0.0.1:5196', 'http://localhost:5196'];
        if (!allowed.includes(req.headers.origin)) throw new ApiError('FORBIDDEN', '不允许跨站访问。', 403);
      }
      const cookies = parseCookies(req);
      const sessionToken = cookies[COOKIE];
      const user = await store.getUserBySession(sessionToken);
      const noAuth = () => { if (!user) throw new ApiError('AUTH_REQUIRED', '请先登录。', 401); return user; };

      // ---- 无需认证 ----
      if (req.method === 'GET' && u.pathname === '/api/v1/health') {
        return json(res, 200, { status: 'ok', time: new Date().toISOString() });
      }
      if (req.method === 'GET' && u.pathname === '/api/v1/auth/admin-status') {
        return json(res, 200, { configured: !!store.state.admin });
      }
      if (req.method === 'POST' && ['/api/v1/auth/admin-setup', '/api/v1/auth/admin-login'].includes(u.pathname)) {
        const body = await readBody(req, 4096);
        const result = u.pathname.endsWith('admin-setup')
          ? await adminAuth.setup(body.setupToken, body.password)
          : await adminAuth.login(body.password);
        setCookie(result.sessionToken, 60 * 60 * 24 * 7);
        return json(res, 200, { user: result.user });
      }
      if (req.method === 'POST' && u.pathname === '/api/v1/admin/invite') {
        noAuth();
        if (user.role !== 'admin') throw new ApiError('FORBIDDEN', '需要管理员权限。', 403);
        return json(res, 201, { inviteToken: await store.createInvite() });
      }
      if (req.method === 'POST' && u.pathname === '/api/v1/auth/accept-invite') {
        const body = await readBody(req);
        const result = await store.acceptInvite(body.inviteToken, body.name);
        setCookie(result.sessionToken, 60 * 60 * 24 * 7);
        return json(res, 200, { user: result.user });
      }
      if (req.method === 'GET' && u.pathname === '/api/v1/capabilities') {
        return json(res, 200, CAPABILITIES);
      }
      if (req.method === 'GET' && u.pathname === '/api/v1/styles') {
        return json(res, 200, { styles: STYLES, customDescriptionSupported: true });
      }

      // ---- 需要认证 ----
      const owner = noAuth();
      const ownerId = owner.id;

      if (req.method === 'GET' && u.pathname === '/api/v1/me') {
        return json(res, 200, { user: { id: owner.id, name: owner.name, role: owner.role || 'member' }, ...(await store.getStats(ownerId)) });
      }
      if (req.method === 'POST' && u.pathname === '/api/v1/auth/logout') {
        await store.logout(sessionToken);
        setCookie('', 0);
        return json(res, 200, { ok: true });
      }

      // 项目
      const projMatch = u.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
      if (req.method === 'GET' && u.pathname === '/api/v1/projects') {
        return json(res, 200, { projects: await store.listProjects(ownerId) });
      }
      if (req.method === 'POST' && u.pathname === '/api/v1/projects') {
        const body = await readBody(req);
        return json(res, 201, { project: await store.createProject(ownerId, body.name) });
      }
      if (projMatch && req.method === 'GET') {
        return json(res, 200, { project: await store.getProject(ownerId, projMatch[1]) });
      }
      if (projMatch && req.method === 'PUT') {
        const body = await readBody(req);
        return json(res, 200, { project: await store.updateProject(ownerId, projMatch[1], body.expectedRevision, body) });
      }

      // 素材
      if (req.method === 'GET' && u.pathname === '/api/v1/assets') {
        const projectId = u.searchParams.get('projectId') || undefined;
        return json(res, 200, { assets: await store.listAssetVersions(ownerId, projectId) });
      }
      if (req.method === 'POST' && u.pathname === '/api/v1/assets') {
        const body = await readBody(req);
        return json(res, 201, { assetVersion: await store.createAsset(ownerId, body) });
      }

      // 个人素材库（跨项目，按分类）
      if (req.method === 'GET' && u.pathname === '/api/v1/library/assets') {
        const categoryId = u.searchParams.get('categoryId') || undefined;
        const type = u.searchParams.get('type') || undefined;
        return json(res, 200, { assets: await store.listLibraryAssets(ownerId, { categoryId, type }) });
      }
      // 素材分类
      if (req.method === 'GET' && u.pathname === '/api/v1/categories') {
        return json(res, 200, { categories: await store.listCategories(ownerId) });
      }
      if (req.method === 'POST' && u.pathname === '/api/v1/categories') {
        const body = await readBody(req);
        return json(res, 201, { category: await store.createCategory(ownerId, body.name) });
      }
      const catMatch = u.pathname.match(/^\/api\/v1\/categories\/([^/]+)$/);
      if (catMatch && req.method === 'DELETE') {
        await store.deleteCategory(ownerId, catMatch[1]);
        return json(res, 200, { ok: true });
      }
      if (catMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        return json(res, 200, { category: await store.renameCategory(ownerId, catMatch[1], body.name) });
      }
      // 重新归类：PATCH /assets/:versionId/category { categoryId }
      const assetCategoryMatch = u.pathname.match(/^\/api\/v1\/assets\/([^/]+)\/category$/);
      if (assetCategoryMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        return json(res, 200, { assetVersion: await store.updateAssetCategory(ownerId, assetCategoryMatch[1], body.categoryId ?? null) });
      }
      // 受保护资源访问：归属校验后返回真实文件实体
      const assetContentMatch = u.pathname.match(/^\/api\/v1\/assets\/([^/]+)\/content$/);
      if (assetContentMatch && req.method === 'GET') {
        const file = await store.readAssetFile(ownerId, assetContentMatch[1]);
        res.writeHead(200, {
          'Content-Type': file.mime || 'application/octet-stream',
          'Content-Length': file.bytes.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(file.bytes);
      }
      // 管理员设额度（仅限本机，B4 部署时换成管理员鉴权）
      if (req.method === 'POST' && u.pathname === '/api/v1/admin/quota') {
        if (owner.role !== 'admin') throw new ApiError('FORBIDDEN', '需要管理员权限。', 403);
        const body = await readBody(req);
        const quota = await store.setQuota(body.userId, { budget: body.budget });
        return json(res, 200, { quota });
      }

      // 任务（只读，B2 补生成）
      if (req.method === 'GET' && u.pathname === '/api/v1/tasks') {
        const projectId = u.searchParams.get('projectId') || undefined;
        return json(res, 200, { tasks: await store.listTasks(ownerId, projectId) });
      }
      const taskMatch = u.pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
      if (taskMatch && req.method === 'GET') {
        return json(res, 200, { task: await store.getTask(ownerId, taskMatch[1]) });
      }
      // B3 action：retry_preparation / continue_text_only / cancel
      const actionMatch = u.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/actions$/);
      if (actionMatch && req.method === 'POST') {
        const body = await readBody(req);
        const result = await gen.act(ownerId, actionMatch[1], { action: body.action, actionId: body.actionId });
        return json(res, result.replayed ? 200 : 202, { task: result.task, replayed: result.replayed });
      }

      // 生成：B2 幂等 + 多参考冻结 + 费用估算（不触发真实媒体，B3 接供应商）
      if (req.method === 'POST' && u.pathname === '/api/v1/generations') {
        const body = await readBody(req);
        const result = await gen.submit(ownerId, body);
        return json(res, result.replayed ? 200 : 202, { task: result.task, replayed: result.replayed });
      }

      throw new ApiError('NOT_FOUND', '接口不存在。', 404);
    } catch (e) {
      if (e instanceof ApiError) {
        const body = { error: { code: e.code, message: e.message, ...(e.extra || {}) } };
        return json(res, e.status || 500, body);
      }
      return json(res, 500, { error: { code: 'INTERNAL', message: '服务处理失败，请稍后重试。' } });
    }
  });

  return server;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}
