// 镜流 B1：v1 服务端数据存储模块
// 职责：用户/项目/素材版本/任务 的服务端持久化 + 乐观并发 + 用户归属校验。
// 存储介质：本机 JSON 文件（与旧 service.mjs 的 state.json 隔离，用不同文件名）。
// 注意：这是 B1 的单机可恢复存储，多用户生产部署可在 B4 换成真实数据库，接口保持等价语义。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export class ApiError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra; // { retryable, allowedActions, traceId }
  }
}

function isUuid(s) {
  return typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
}

// 归一化归属性：所有被用户引用的资源必须带 ownerId
// 越权统一 404（NOT_FOUND），不泄露对象存在性（接口草案第 6 节）
function assertOwned(obj, ownerId, label) {
  if (!obj || obj.ownerId !== ownerId) throw new ApiError('NOT_FOUND', `${label} 不存在。`, 404);
  return obj;
}

// 真实文件类型嗅探（Codex 反馈第 6 条）：不信任声明的 mime/ext，按魔术字节判断。
// 返回 { mime, ext }，不合法抛 INPUT_INVALID。
const MAX_ASSET_BYTES = 40_000_000;
function sniffAssetType(buf) {
  if (!buf || buf.length < 16) throw new ApiError('INPUT_INVALID', '文件内容无效或过小。', 400);
  if (buf.length > MAX_ASSET_BYTES) throw new ApiError('LARGE', '文件超过 40MB 上限。', 413);
  // PNG
  if (buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', ext: 'png' };
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  // WebP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  // MP4 (ftyp box)
  if (buf.toString('ascii', 4, 8) === 'ftyp') return { mime: 'video/mp4', ext: 'mp4' };
  throw new ApiError('INPUT_INVALID', '仅支持真实 PNG、JPEG、WebP、MP4 文件。', 400);
}

export class V1Store {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'v1-state.json');
    this.filesDir = path.join(directory, 'files');
    // 邀请令牌 → { used, ownerId, createdAt, tokenHash }
    this.state = {
      invites: {},      // token -> invite 记录
      users: {},        // userId -> { id, name, quota, createdAt }
      sessions: {},     // sessionToken -> userId 或 {userId, expiresAt}
      projects: {},     // projectId -> Project
      assetVersions: {},// assetVersionId -> AssetVersion
      assets: {},       // assetId -> { id, ownerId, kind, versions: [versionId], currentVersionId }
      tasks: {},        // taskId -> Task
      categories: {},   // categoryId -> { id, ownerId, name, createdAt }  （用户级素材分类）
    };
    this.writeQueue = Promise.resolve();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    await mkdir(this.directory, { recursive: true });
    await mkdir(this.filesDir, { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('schema');
      this.state = { ...this.state, ...parsed };
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('v1 本地状态无法读取，已停止以保护记录。');
    }
    this.loaded = true;
  }

  persist() {
    const data = JSON.stringify(this.state, null, 2);
    const job = this.writeQueue.then(async () => {
      await writeFile(this.file + '.tmp', data, { mode: 0o600 });
      await rename(this.file + '.tmp', this.file);
    });
    this.writeQueue = job.catch(() => {});
    return job;
  }

  async flush() {
    await this.writeQueue;
  }

  // ---------- 用户 / 邀请 / 会话 ----------

  async createUser(name) {
    const id = randomUUID();
    const user = { id, name: String(name || '受邀用户').slice(0, 100), quota: { budget: 0, used: 0 }, createdAt: new Date().toISOString() };
    this.state.users[id] = user;
    await this.persist();
    return { ...user };
  }

  async acceptInvite(token, userName) {
    if (typeof token !== 'string' || token.length < 8 || token.length > 200) {
      throw new ApiError('INVITE_INVALID', '邀请码无效。', 401);
    }
    const invite = this.state.invites[token];
    if (!invite) throw new ApiError('INVITE_INVALID', '邀请码无效或已失效。', 401);
    if (invite.used) throw new ApiError('INVITE_INVALID', '邀请码已被使用。', 401);
    const user = await this.createUser(userName);
    invite.used = true;
    invite.usedBy = user.id;
    invite.usedAt = new Date().toISOString();
    const sessionToken = this.newSession(user.id);
    await this.persist();
    return { userId: user.id, sessionToken, user: { id: user.id, name: user.name, quota: user.quota } };
  }

  // 建立会话（统一带 30 天过期）
  newSession(userId, ttlMs = 30 * 86400_000) {
    const token = randomUUID() + randomUUID();
    this.state.sessions[token] = { userId, expiresAt: Date.now() + ttlMs };
    return token;
  }

  async createInvite() {
    // 管理员建房：生成一次性邀请码（本阶段用于 fixture，B4 换成管理员接口）
    const token = randomUUID().replace(/-/g, '').slice(0, 16);
    this.state.invites[token] = { used: false, createdAt: new Date().toISOString() };
    await this.persist();
    return token;
  }

  async getUserBySession(sessionToken) {
    if (typeof sessionToken !== 'string' || !sessionToken) return null;
    const session = this.state.sessions[sessionToken];
    if (!session) return null;
    if (typeof session === 'object' && session.expiresAt <= Date.now()) return null;
    const userId = typeof session === 'string' ? session : session.userId;
    const user = this.state.users[userId];
    return user ? { ...user } : null;
  }

  async logout(sessionToken) {
    if (sessionToken && this.state.sessions[sessionToken]) {
      delete this.state.sessions[sessionToken];
      await this.persist();
    }
  }

  // ---------- 项目 CRUD（乐观并发）----------

  async listProjects(ownerId) {
    return Object.values(this.state.projects)
      .filter((p) => p.ownerId === ownerId)
      .map((p) => this.projectSummary(p))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  projectSummary(p) {
    return { id: p.id, name: p.name, revision: p.revision, updatedAt: p.updatedAt /* 不含 nodes/edges 大对象，列表用 */ };
  }

  async getProject(ownerId, projectId) {
    const p = this.state.projects[projectId];
    if (!p || p.ownerId !== ownerId) throw new ApiError('NOT_FOUND', '项目不存在。', 404);
    return structuredClone(p);
  }

  async createProject(ownerId, name) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const p = {
      id,
      ownerId,
      name: String(name || '未命名项目').slice(0, 100),
      revision: 1,
      nodes: [],
      referenceEdges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: now,
      updatedAt: now,
    };
    this.state.projects[id] = p;
    await this.persist();
    return structuredClone(p);
  }

  async updateProject(ownerId, projectId, expectedRevision, patch) {
    const p = this.state.projects[projectId];
    // 统一 404，不泄露对象存在性（接口草案第 6 节）
    if (!p || p.ownerId !== ownerId) throw new ApiError('NOT_FOUND', '项目不存在。', 404);
    if (expectedRevision !== undefined && expectedRevision !== p.revision) {
      throw new ApiError('PROJECT_CONFLICT', '项目已被他人修改，请刷新后重试。', 409, { currentRevision: p.revision });
    }
    const allowed = ['name', 'nodes', 'referenceEdges', 'viewport'];
    for (const k of allowed) {
      if (patch[k] !== undefined) p[k] = patch[k];
    }
    p.revision += 1;
    p.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(p);
  }

  // 服务端解析前序节点（Codex 反馈第 3 条）：不信任前端 predecessorKind，
  // 严格用 context.sourceNodeId 定位承接来源，不允许参考连线覆盖唯一承接来源。
  async resolvePredecessor(ownerId, { projectId, nodeId, context }) {
    const p = this.state.projects[projectId];
    if (!p || p.ownerId !== ownerId) throw new ApiError('NOT_FOUND', '项目不存在。', 404);
    const sourceNodeId = context?.sourceNodeId;
    if (!sourceNodeId) return { predecessor: null, reason: 'no_source' };

    // G02 修复：自指拒绝（承接不能指向自身）。
    if (sourceNodeId === nodeId) {
      throw new ApiError('CONTEXT_SOURCE_INVALID', '承接不能指向自身。', 400);
    }

    // G02 修复：循环检测。边 {source,target} 表示 target 承接 source（target 依赖 source）。
    // 新增 nodeId 承接 sourceNodeId 前，检查 sourceNodeId 是否已（沿上游）依赖 nodeId，若是则成环。
    const edges = Array.isArray(p.referenceEdges) ? p.referenceEdges : [];
    const visited = new Set();
    const stack = [sourceNodeId];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === nodeId) {
        throw new ApiError('CONTEXT_SOURCE_INVALID', '承接关系存在循环，无法建立。', 400);
      }
      if (visited.has(cur)) continue;
      visited.add(cur);
      // 找 cur 的所有上游（谁被 cur 依赖？不，找 cur 依赖谁：cur 是 target 时它的 source 是上游）
      for (const e of edges) {
        if (e.target === cur) stack.push(e.source);
      }
    }

    const nodes = Array.isArray(p.nodes) ? p.nodes : [];
    const source = nodes.find(n => n.id === sourceNodeId);
    const current = nodes.find(n => n.id === nodeId);
    if (!source) throw new ApiError('CONTEXT_SOURCE_INVALID', '承接来源节点不存在。', 400);
    if (!current) throw new ApiError('INPUT', '当前节点不存在。', 400);

    // 同类型约束：基于服务端节点 kind，不靠前端
    const sourceKind = source.kind || source.type;
    const currentKind = current.kind || current.type;
    if (sourceKind !== currentKind) {
      throw new ApiError('CONTEXT_SOURCE_INVALID', `承接仅支持同类型：${currentKind} 不能承接 ${sourceKind}。`, 400);
    }

    // 版本选择（Codex 反馈第 3 条 + 复核问题 2）：显式指定历史版本 sourceVersionId 时用它；
    // 否则用当前采用版 adoptedVersionId。并校验版本归属（属于该前序节点，不跨节点/项目/用户）。
    const explicitVersionId = context.sourceVersionId ?? null;
    const versionId = explicitVersionId || source.adoptedVersionId || null;
    let adoptedVersion = null;
    if (versionId) {
      const v = this.state.assetVersions[versionId];
      if (!v || v.ownerId !== ownerId) {
        throw new ApiError('CONTEXT_SOURCE_INVALID', '承接来源的采用版本不存在或无权访问。', 400);
      }
      // 归属校验（缺口 3）：区分上传素材 vs 生成历史。
      // - 版本必须属于该项目（或为跨项目复用的上传素材，见下）。
      // - 上传素材（nodeId 为空）可跨项目复用，不阻断。
      // - 生成历史（nodeId 存在）必须匹配指定承接来源节点，不能跨节点冒充。
      if (v.projectId && p.id !== v.projectId) {
        // 跨项目：仅允许上传素材复用；生成历史不允许跨项目
        if (v.kind !== 'upload' || v.nodeId) {
          throw new ApiError('CONTEXT_SOURCE_INVALID', '该生成历史不属于当前项目，不能作为承接来源。', 400);
        }
      }
      if (v.nodeId && v.nodeId !== source.id) {
        throw new ApiError('CONTEXT_SOURCE_INVALID', '该版本不属于指定的承接来源节点。', 400);
      }
      adoptedVersion = structuredClone(v);
    }

    return {
      predecessor: {
        id: source.id,
        kind: sourceKind,
        // 原文优先级（缺口 1）：优先该版本的生成原文（adoptedVersion.sourceText），
        // 没有（上传素材无生成原文）则回退到节点当前 userInput。
        originalPrompt: adoptedVersion?.sourceText ?? source.userInput ?? source.originalPrompt ?? source.text ?? null,
        adoptedVersionId: versionId ?? null,
        adoptedVersion,
        usedExplicitVersion: !!explicitVersionId,
      },
    };
  }

  // 校验参考素材实体与模型能力（Codex 复核问题 2/3）：付费调用前验证归属、可读实体、真实类型、
  // 数量上限、角色用途、image/video 类型匹配。有问题直接报错，不静默丢图/超限。
  async validateReferences(ownerId, mediaReferences = [], limits = {}) {
    if (!Array.isArray(mediaReferences)) throw new ApiError('INPUT_INVALID', '参考素材格式错误。', 400);
    const maxCount = limits.maxCount ?? 1;
    const allowedMimes = limits.allowedMimes ?? ['image/png', 'image/jpeg', 'image/webp', 'video/mp4'];
    const allowedRoles = limits.allowedRoles ?? ['reference', 'first_frame', 'last_frame'];
    if (mediaReferences.length > maxCount) {
      throw new ApiError('UNSUPPORTED_REFERENCE', `参考素材最多 ${maxCount} 项，当前 ${mediaReferences.length} 项。`, 400);
    }
    const result = [];
    for (const ref of mediaReferences) {
      if (!ref || typeof ref.assetVersionId !== 'string') {
        throw new ApiError('INPUT_INVALID', '参考素材缺少有效版本 ID。', 400);
      }
      if (!allowedRoles.includes(ref.role)) {
        throw new ApiError('UNSUPPORTED_REFERENCE', `参考角色 ${ref.role} 不被当前模型支持。`, 400);
      }
      const v = this.state.assetVersions[ref.assetVersionId];
      if (!v || v.ownerId !== ownerId) {
        throw new ApiError('NOT_FOUND', '参考素材不存在或无权访问。', 404);
      }
      if (!v.filename) {
        throw new ApiError('INPUT_INVALID', `参考素材 ${ref.assetVersionId} 没有可用的文件实体。`, 400);
      }
      if (!allowedMimes.includes(v.mime)) {
        throw new ApiError('UNSUPPORTED_REFERENCE', `参考素材类型 ${v.mime} 不被当前模型支持。`, 400);
      }
      result.push({ assetVersionId: v.id, role: ref.role || 'reference', mime: v.mime, ext: v.ext });
    }
    return result;
  }

  // ---------- 素材分类（个人库，用户级，B 方案：手动分类） ----------

  async createCategory(ownerId, name) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const cat = { id, ownerId, name: String(name || '未命名分类').slice(0, 50), createdAt: now };
    this.state.categories[id] = cat;
    await this.persist();
    return structuredClone(cat);
  }

  async listCategories(ownerId) {
    return Object.values(this.state.categories)
      .filter((c) => c.ownerId === ownerId)
      .map((c) => structuredClone(c))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  async deleteCategory(ownerId, categoryId) {
    const c = this.state.categories[categoryId];
    if (!c || c.ownerId !== ownerId) throw new ApiError('NOT_FOUND', '分类不存在。', 404);
    delete this.state.categories[categoryId];
    // 解除素材与该分类的关联（不移除素材本身）
    for (const v of Object.values(this.state.assetVersions)) {
      if (v.ownerId === ownerId && v.categoryId === categoryId) v.categoryId = null;
    }
    await this.persist();
  }

  async renameCategory(ownerId, categoryId, name) {
    const c = this.state.categories[categoryId];
    if (!c || c.ownerId !== ownerId) throw new ApiError('NOT_FOUND', '分类不存在。', 404);
    if (!name || !String(name).trim()) throw new ApiError('INPUT_INVALID', '分类名不能为空。', 400);
    c.name = String(name).trim().slice(0, 50);
    await this.persist();
    return structuredClone(c);
  }

  // 重新归类：仅允许上传素材（kind=upload），生成结果属于对应画布历史，不允许归类到个人库。
  // categoryId 可为 null（移回未分类）；校验资产与分类均归属当前用户；不改 version ID、不复制文件。
  async updateAssetCategory(ownerId, versionId, categoryId) {
    const v = this.state.assetVersions[versionId];
    if (!v || v.ownerId !== ownerId) throw new ApiError('NOT_FOUND', '素材不存在或无权访问。', 404);
    if (v.kind !== 'upload') throw new ApiError('INPUT_INVALID', '仅上传素材可加入分类，生成结果属于对应画布。', 400);
    if (categoryId != null) {
      const c = this.state.categories[categoryId];
      if (!c || c.ownerId !== ownerId) throw new ApiError('NOT_FOUND', '分类不存在或无权使用。', 404);
    }
    v.categoryId = categoryId ?? null;
    await this.persist();
    return structuredClone(v);
  }

  // 个人素材库：列出本人所有上传素材版本（跨项目），可选按分类筛选。
  // 上传素材（kind=upload）与生成结果（kind=generated）分开列。
  async listLibraryAssets(ownerId, { categoryId = null, type = null } = {}) {
    let list = Object.values(this.state.assetVersions).filter((v) => v.ownerId === ownerId);
    if (categoryId) list = list.filter((v) => v.categoryId === categoryId);
    if (type === 'upload') list = list.filter((v) => v.kind === 'upload');
    else if (type === 'generated') list = list.filter((v) => v.kind === 'generated');
    list = list.map((v) => structuredClone(v));
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return list;
  }

  // ---------- 素材 / 版本 ----------

  async createAsset(ownerId, { projectId, kind, mime, ext, name, dataUrl, bytes, nodeId, taskId, sourceText, categoryId }) {
    if (projectId) this.assertProjectOwned(ownerId, projectId);
    // 分类归属校验：categoryId 必须属于当前用户
    if (categoryId) {
      const c = this.state.categories[categoryId];
      if (!c || c.ownerId !== ownerId) throw new ApiError('INPUT_INVALID', '素材分类不存在或无权使用。', 400);
    }
    const assetId = randomUUID();
    const versionId = randomUUID();
    const now = new Date().toISOString();
    // 真实文件落盘
    let filename = null, size = 0;
    let buf = null;
    if (dataUrl && typeof dataUrl === 'string') {
      const m = dataUrl.match(/^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
      if (!m) throw new ApiError('INPUT_INVALID', '素材数据格式错误。', 400);
      buf = Buffer.from(m[2], 'base64');
    } else if (bytes) {
      buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    }

    // 真实类型嗅探（Codex 反馈第 6 条）：不信任声明 mime/ext，按内容判断并覆盖。
    let realType = null;
    if (buf && buf.length > 0) {
      realType = sniffAssetType(buf);
      filename = versionId + '.' + realType.ext;
      await writeFile(path.join(this.filesDir, filename), buf);
      size = buf.length;
    }
    const finalMime = realType?.mime || mime || 'application/octet-stream';
    const finalExt = realType?.ext || ext || 'bin';
    const asset = { id: assetId, ownerId, kind: kind || 'upload', versions: [versionId], currentVersionId: versionId, createdAt: now };
    const version = { id: versionId, assetId, ownerId, projectId: projectId || null, nodeId: nodeId || null, taskId: taskId || null, sourceText: sourceText ?? null, categoryId: categoryId || null, kind: kind || 'upload', mime: finalMime, ext: finalExt, name: String(name || '未命名素材').slice(0, 100), filename, size, createdAt: now };
    this.state.assets[assetId] = asset;
    this.state.assetVersions[versionId] = version;
    await this.persist();
    return structuredClone(version);
  }

  // 读取资产文件实体（归属校验后返回 bytes + mime）
  async readAssetFile(ownerId, versionId) {
    const v = assertOwned(this.state.assetVersions[versionId], ownerId, '素材版本');
    if (!v.filename) throw new ApiError('NOT_FOUND', '该素材无文件实体。', 404);
    const bytes = await readFile(path.join(this.filesDir, v.filename));
    return { bytes, mime: v.mime, ext: v.ext, filename: v.filename };
  }

  assertProjectOwned(ownerId, projectId) {
    const p = this.state.projects[projectId];
    if (!p || p.ownerId !== ownerId) throw new ApiError('NOT_FOUND', '项目不存在。', 404);
  }

  async listAssetVersions(ownerId, projectId) {
    if (projectId) this.assertProjectOwned(ownerId, projectId);
    return Object.values(this.state.assetVersions)
      .filter((v) => v.ownerId === ownerId && (!projectId || v.projectId === projectId))
      .map((v) => structuredClone(v));
  }

  // 受保护资源访问：归属校验后返回元数据 + 可选文件路径（B4）
  async getAssetVersion(ownerId, versionId) {
    const v = assertOwned(this.state.assetVersions[versionId], ownerId, '素材版本');
    return structuredClone(v);
  }

  // ---------- Task ----------

  async createTask(ownerId, task) {
    // 校验归属：projectId 必须存在且属于该用户（Codex 反馈第 2 条）
    if (task.projectId) this.assertProjectOwned(ownerId, task.projectId);
    const id = randomUUID();
    const now = new Date().toISOString();
    const rec = { id, ownerId, status: 'preparing', phase: 'validation', createdAt: now, updatedAt: now, ...task };
    this.state.tasks[id] = rec;
    await this.persist();
    return structuredClone(rec);
  }

  async getTask(ownerId, taskId) {
    return structuredClone(assertOwned(this.state.tasks[taskId], ownerId, '任务'));
  }

  async listTasks(ownerId, projectId) {
    return Object.values(this.state.tasks)
      .filter((t) => t.ownerId === ownerId && (!projectId || t.projectId === projectId))
      .map((t) => structuredClone(t));
  }

  async getStats(ownerId) {
    const projects = Object.values(this.state.projects).filter((p) => p.ownerId === ownerId).length;
    const assets = Object.values(this.state.assets).filter((a) => a.ownerId === ownerId).length;
    const tasks = Object.values(this.state.tasks).filter((t) => t.ownerId === ownerId).length;
    const user = this.state.users[ownerId];
    return { projects, assets, tasks, quota: user ? user.quota : { budget: 0, used: 0 } };
  }

  // ---- 额度（B4）----
  async setQuota(ownerId, { budget }) {
    const user = this.state.users[ownerId];
    if (!user) throw new ApiError('NOT_FOUND', '用户不存在。', 404);
    if (typeof budget !== 'number' || budget < 0) throw new ApiError('INPUT', '额度预算需为非负数字。', 400);
    user.quota.budget = budget;
    await this.persist();
    return { ...user.quota };
  }

  async checkQuota(ownerId, cost) {
    const user = this.state.users[ownerId];
    if (!user) throw new ApiError('NOT_FOUND', '用户不存在。', 404);
    const quota = user.quota;
    // G04 修复：预留额度（reserved）也要计入，防止并发任务超预算。
    const reserved = quota.reserved || 0;
    if (quota.budget > 0 && quota.used + reserved + cost > quota.budget) {
      throw new ApiError('QUOTA_EXCEEDED', `已超出额度上限（已用 ${quota.used}，已预留 ${reserved}，本次 ${cost}）。`, 409, { used: quota.used, reserved, budget: quota.budget, requestCost: cost });
    }
    return quota;
  }

  // G04：原子预留额度（提交排队时占用），返回预留后 quota。
  async reserveQuota(ownerId, cost) {
    const user = this.state.users[ownerId];
    if (!user) throw new ApiError('NOT_FOUND', '用户不存在。', 404);
    user.quota.reserved = Number(((user.quota.reserved || 0) + cost).toFixed(2));
    await this.persist();
    return { ...user.quota };
  }

  // G04：释放预留（取消未发送任务时），并把预留转为实际消耗（入账）时调用。
  async releaseQuota(ownerId, cost) {
    const user = this.state.users[ownerId];
    if (!user) return;
    user.quota.reserved = Number(Math.max(0, (user.quota.reserved || 0) - cost).toFixed(2));
    await this.persist();
    return { ...user.quota };
  }

  async recordUsage(ownerId, cost) {
    const user = this.state.users[ownerId];
    if (!user) return;
    user.quota.used = Number((user.quota.used + cost).toFixed(2));
    await this.persist();
  }
}
