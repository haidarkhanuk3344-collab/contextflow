import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { V1Store, ApiError } from '../server/v1/store.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jingliu-v1-'));
  const store = new V1Store(dir);
  await store.load();
  t.after(async () => { await store.flush(); await rm(dir, { recursive: true, force: true }); });
  return { store };
}

test('邀请码一次性使用，建立会话并创建独立用户', async (t) => {
  const { store } = await fixture(t);
  const token = await store.createInvite();
  const a = await store.acceptInvite(token, '用户甲');
  assert.ok(a.userId, '首次使用成功');
  assert.ok(a.sessionToken, '返回会话令牌');
  // 不同用户分别获得独立 userId
  const t2 = await store.createInvite();
  const b = await store.acceptInvite(t2, '用户乙');
  assert.notEqual(a.userId, b.userId, '不同邀请产生不同用户');
});

test('邀请码不可重复使用', async (t) => {
  const { store } = await fixture(t);
  const token = await store.createInvite();
  await store.acceptInvite(token, '甲');
  await assert.rejects(store.acceptInvite(token, '乙'), (e) => e.code === 'INVITE_INVALID');
});

test('两个用户项目与素材完全隔离', async (t) => {
  const { store } = await fixture(t);
  const u1 = await store.acceptInvite(await store.createInvite(), '甲');
  const u2 = await store.acceptInvite(await store.createInvite(), '乙');

  const p1 = await store.createProject(u1.userId, '甲的项目');
  const p2 = await store.createProject(u2.userId, '乙的项目');

  // 乙不能读甲的项目（404 不泄露存在性）
  await assert.rejects(store.getProject(u2.userId, p1.id), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(store.updateProject(u2.userId, p1.id, 1, { name: '篡改' }), (e) => e.code === 'NOT_FOUND');

  // 各自列表互不可见
  const l1 = await store.listProjects(u1.userId);
  const l2 = await store.listProjects(u2.userId);
  assert.equal(l1.length, 1);
  assert.equal(l2.length, 1);
  assert.equal(l1[0].id, p1.id);
  assert.equal(l2[0].id, p2.id);
});

test('项目保存冲突检测（乐观并发 revision）', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p = await store.createProject(u.userId, '项目');
  // 正常保存
  const updated = await store.updateProject(u.userId, p.id, p.revision, { name: '新名' });
  assert.equal(updated.revision, p.revision + 1);
  // 用旧 revision 再次保存 → 冲突
  await assert.rejects(store.updateProject(u.userId, p.id, p.revision, { name: '再改' }), (e) => e.code === 'PROJECT_CONFLICT');
});

test('多参考素材版本独立、可列表、归属校验', async (t) => {
  const { store } = await fixture(t);
  const u1 = await store.acceptInvite(await store.createInvite(), '甲');
  const u2 = await store.acceptInvite(await store.createInvite(), '乙');
  const p = await store.createProject(u1.userId, '项目');

  const ref1 = await store.createAsset(u1.userId, { projectId: p.id, kind: 'upload', mime: 'image/png', ext: 'png', name: '参考图1' });
  const ref2 = await store.createAsset(u1.userId, { projectId: p.id, kind: 'upload', mime: 'image/png', ext: 'png', name: '参考图2' });

  // 多参考数据结构：数组 + role
  const mediaReferences = [
    { assetVersionId: ref1.id, role: 'reference' },
    { assetVersionId: ref2.id, role: 'first_frame' },
  ];
  assert.equal(mediaReferences.length, 2);
  assert.ok(mediaReferences.every((r) => r.assetVersionId && r.role));

  // u1 能看到 2 个版本；u2 查询 u1 的项目应被拒（不泄露存在性）
  const l1 = await store.listAssetVersions(u1.userId, p.id);
  assert.equal(l1.length, 2);
  await assert.rejects(store.listAssetVersions(u2.userId, p.id), (e) => e.code === 'NOT_FOUND');
});

test('任务冻结输入并持久化，重启后可恢复', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jingliu-v1-task-'));
  const s1 = new V1Store(dir);
  await s1.load();
  const u = await s1.acceptInvite(await s1.createInvite(), '甲');
  const p = await s1.createProject(u.userId, '项目');
  const task = await s1.createTask(u.userId, {
    requestId: 'req-1', projectId: p.id, projectRevision: p.revision, nodeId: 'node-a',
    frozenInput: { text: '一只猫', mediaReferences: [], context: { enabled: false } },
  });
  await s1.flush();

  const s2 = new V1Store(dir);
  await s2.load();
  const restored = await s2.getTask(u.userId, task.id);
  assert.equal(restored.frozenInput.text, '一只猫');
  assert.equal(restored.status, 'preparing');
  await s2.flush();
  await rm(dir, { recursive: true, force: true });
});

test('服务端 resolvePredecessor：从项目节点解析同类型前序，不靠前端 predecessorKind', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p = await store.createProject(u.userId, '项目');
  const nodeA = { id: 'node-a', kind: 'image', userInput: '前序图片描述' };
  const nodeB = { id: 'node-b', kind: 'image', userInput: '当前图片描述' };
  const nodeV = { id: 'node-v', kind: 'video', userInput: '视频描述' };
  // 保存项目：A→B 承接（同类型 image）
  await store.updateProject(u.userId, p.id, 1, {
    nodes: [nodeA, nodeB, nodeV],
    referenceEdges: [{ source: 'node-a', target: 'node-b' }],
  });

  // 同类型：image 承 image，应成功
  const r1 = await store.resolvePredecessor(u.userId, { projectId: p.id, nodeId: 'node-b', context: { enabled: true, sourceNodeId: 'node-a' } });
  assert.equal(r1.predecessor.id, 'node-a');
  assert.equal(r1.predecessor.kind, 'image');
  assert.equal(r1.predecessor.originalPrompt, '前序图片描述');
});

test('服务端 resolvePredecessor 跨类型拒绝（CONTEXT_SOURCE_INVALID）', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p = await store.createProject(u.userId, '项目');
  await store.updateProject(u.userId, p.id, 1, {
    nodes: [
      { id: 'v1', kind: 'video', userInput: '视频' },
      { id: 'i1', kind: 'image', userInput: '图' },
    ],
    referenceEdges: [],
  });
  // i1 尝试承 v1（跨类型）
  await assert.rejects(
    store.resolvePredecessor(u.userId, { projectId: p.id, nodeId: 'i1', context: { enabled: true, sourceNodeId: 'v1' } }),
    (e) => e.code === 'CONTEXT_SOURCE_INVALID'
  );
});

test('resolvePredecessor 严格用 sourceNodeId，不被其他连线覆盖（Codex 反馈第2条）', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p = await store.createProject(u.userId, '项目');
  // 两个前序 A、C 都连到 B（参考连线），但用户指定承接 C
  await store.updateProject(u.userId, p.id, 1, {
    nodes: [
      { id: 'a', kind: 'image', userInput: 'A' },
      { id: 'c', kind: 'image', userInput: 'C' },
      { id: 'b', kind: 'image', userInput: 'B' },
    ],
    referenceEdges: [{ source: 'a', target: 'b' }, { source: 'c', target: 'b' }],
  });
  // 指定承接 C，应严格返回 C，而不是退回任意连线里的 A
  const r = await store.resolvePredecessor(u.userId, { projectId: p.id, nodeId: 'b', context: { enabled: true, sourceNodeId: 'c' } });
  assert.equal(r.predecessor.id, 'c');
  assert.equal(r.predecessor.originalPrompt, 'C');
});

test('resolvePredecessor 指定历史版本 sourceVersionId 生效（Codex 反馈第3条）', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p = await store.createProject(u.userId, '项目');
  // 建两个版本 v1、v2
  const v1 = await store.createAsset(u.userId, { projectId: p.id, kind: 'generated', mime: 'image/jpeg', ext: 'jpg', name: 'v1', bytes: Buffer.from([0xff,0xd8,0xff,0xe0,0,16,'J','F','I','F',0,1,1,0,0,1,0,1,0,0]) });
  const v2 = await store.createAsset(u.userId, { projectId: p.id, kind: 'generated', mime: 'image/jpeg', ext: 'jpg', name: 'v2', bytes: Buffer.from([0xff,0xd8,0xff,0xe0,0,16,'J','F','I','F',0,1,1,0,0,1,0,1,0,0]) });
  // node-a 采用 v2，但显式指定历史版本 v1
  await store.updateProject(u.userId, p.id, 1, {
    nodes: [{ id: 'a', kind: 'image', userInput: 'A', adoptedVersionId: v2.id }, { id: 'b', kind: 'image', userInput: 'B' }],
    referenceEdges: [],
  });
  const r = await store.resolvePredecessor(u.userId, { projectId: p.id, nodeId: 'b', context: { enabled: true, sourceNodeId: 'a', sourceVersionId: v1.id } });
  assert.equal(r.predecessor.adoptedVersionId, v1.id, '应使用显式指定的历史版本');
  assert.equal(r.predecessor.usedExplicitVersion, true);
});

test('createAsset 嗅探真实文件类型，拒绝伪造 mime（Codex 反馈第6条）', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p = await store.createProject(u.userId, '项目');
  // 内容其实是 PNG，但声明 mime=text/html，应被嗅探纠正为 png
  const pngBytes = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,0,0,0,0,0,0]);
  const v = await store.createAsset(u.userId, { projectId: p.id, kind: 'upload', mime: 'text/html', ext: 'html', name: '假html', bytes: pngBytes });
  assert.equal(v.mime, 'image/png', '应嗅探出真实 png');
  assert.equal(v.ext, 'png');
  // 非法内容应拒绝
  await assert.rejects(store.createAsset(u.userId, { projectId: p.id, kind: 'upload', mime: 'image/png', ext: 'png', name: '坏文件', bytes: Buffer.from('<html>not an image</html>') }), (e) => e.code === 'INPUT_INVALID');
});

test('validateReferences：版本不存在/无实体/越权时拒绝，不静默丢图（复核问题3）', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p = await store.createProject(u.userId, '项目');
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(24, 0)]);
  const good = await store.createAsset(u.userId, { projectId: p.id, kind: 'upload', mime: 'image/png', ext: 'png', name: '有效', bytes: png });
  // 无实体的（空 bytes）会被拒绝
  const noFile = await store.createAsset(u.userId, { projectId: p.id, kind: 'upload', mime: 'image/png', ext: 'png', name: '空' });
  // 有效参考应通过
  const ok = await store.validateReferences(u.userId, [{ assetVersionId: good.id, role: 'reference' }]);
  assert.equal(ok.length, 1);
  // 无实体参考应拒绝
  await assert.rejects(store.validateReferences(u.userId, [{ assetVersionId: noFile.id, role: 'reference' }]), (e) => e.code === 'INPUT_INVALID');
  // 不存在的版本应拒绝
  await assert.rejects(store.validateReferences(u.userId, [{ assetVersionId: '00000000-0000-0000-0000-000000000000', role: 'reference' }]), (e) => e.code === 'NOT_FOUND');
});

test('resolvePredecessor 校验版本归属：跨项目版本被拒绝（复核问题2）', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p1 = await store.createProject(u.userId, '项目1');
  const p2 = await store.createProject(u.userId, '项目2');
  const jpeg = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(32,0), Buffer.from([0xff,0xd9])]);
  // 版本属于项目2，node 在项目1
  const vOther = await store.createAsset(u.userId, { projectId: p2.id, kind: 'generated', mime: 'image/jpeg', ext: 'jpg', name: '跨项目', bytes: jpeg });
  await store.updateProject(u.userId, p1.id, 1, {
    nodes: [{ id: 'a', kind: 'image', userInput: 'A' }, { id: 'b', kind: 'image', userInput: 'B' }],
    referenceEdges: [],
  });
  // 项目1的 node-b 尝试用项目2的版本承接 node-a → 应拒绝（跨项目）
  await assert.rejects(
    store.resolvePredecessor(u.userId, { projectId: p1.id, nodeId: 'b', context: { enabled: true, sourceNodeId: 'a', sourceVersionId: vOther.id } }),
    (e) => e.code === 'CONTEXT_SOURCE_INVALID'
  );
});

test('素材分类 CRUD + 用户隔离（个人库 B 方案）', async (t) => {
  const { store } = await fixture(t);
  const u1 = await store.acceptInvite(await store.createInvite(), '甲');
  const u2 = await store.acceptInvite(await store.createInvite(), '乙');
  const c1 = await store.createCategory(u1.userId, '人物');
  const c2 = await store.createCategory(u1.userId, '场景');
  assert.equal((await store.listCategories(u1.userId)).length, 2);
  // 乙看不到甲的分类
  assert.equal((await store.listCategories(u2.userId)).length, 0);
  // 删除分类
  await store.deleteCategory(u1.userId, c1.id);
  assert.equal((await store.listCategories(u1.userId)).length, 1);
});

test('个人素材库：跨项目复用同一上传版本，按分类筛选', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p1 = await store.createProject(u.userId, '项目1');
  const p2 = await store.createProject(u.userId, '项目2');
  const cat = await store.createCategory(u.userId, '场景');
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(24, 0)]);
  // 在项目1上传，归到分类"场景"
  const up = await store.createAsset(u.userId, { projectId: p1.id, kind: 'upload', mime: 'image/png', ext: 'png', name: '花园', bytes: png, categoryId: cat.id });
  // 个人库能看到（跨项目）
  const lib = await store.listLibraryAssets(u.userId, { type: 'upload' });
  assert.equal(lib.length, 1);
  assert.equal(lib[0].id, up.id);
  // 按分类筛选
  const byCat = await store.listLibraryAssets(u.userId, { categoryId: cat.id });
  assert.equal(byCat.length, 1);
  // 同一版本可被项目2引用（跨项目复用，不复制）
  const refs = await store.validateReferences(u.userId, [{ assetVersionId: up.id, role: 'reference' }]);
  assert.equal(refs.length, 1);
});

test('个人素材库：生成历史不跨项目，上传素材可跨项目（缺口3）', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p1 = await store.createProject(u.userId, '项目1');
  const p2 = await store.createProject(u.userId, '项目2');
  const jpeg = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(32,0), Buffer.from([0xff,0xd9])]);
  // 项目1的生成结果（带 nodeId）
  const gen = await store.createAsset(u.userId, { projectId: p1.id, kind: 'generated', mime: 'image/jpeg', ext: 'jpg', name: '生成历史', bytes: jpeg, nodeId: 'node-a' });
  await store.updateProject(u.userId, p1.id, 1, { nodes: [{ id: 'node-a', kind: 'image', userInput: 'A' }], referenceEdges: [] });
  await store.updateProject(u.userId, p2.id, 1, { nodes: [{ id: 'node-b', kind: 'image', userInput: 'B' }], referenceEdges: [] });
  // 项目2的 node-b 尝试用项目1的生成历史承接 → 拒绝
  await assert.rejects(
    store.resolvePredecessor(u.userId, { projectId: p2.id, nodeId: 'node-b', context: { enabled: true, sourceNodeId: 'node-b', sourceVersionId: gen.id } }),
    (e) => e.code === 'CONTEXT_SOURCE_INVALID'
  );
});

test('重新归类：仅上传素材可归类，生成结果拒绝', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p = await store.createProject(u.userId, '项目');
  const cat = await store.createCategory(u.userId, '场景');
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(24, 0)]);
  const up = await store.createAsset(u.userId, { projectId: p.id, kind: 'upload', mime: 'image/png', ext: 'png', name: '花园', bytes: png });
  const jpeg = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(32,0), Buffer.from([0xff,0xd9])]);
  const gen = await store.createAsset(u.userId, { projectId: p.id, kind: 'generated', mime: 'image/jpeg', ext: 'jpg', name: '生成', bytes: jpeg, nodeId: 'n' });
  // 上传素材可归类
  const r1 = await store.updateAssetCategory(u.userId, up.id, cat.id);
  assert.equal(r1.categoryId, cat.id);
  // 移回未分类
  const r2 = await store.updateAssetCategory(u.userId, up.id, null);
  assert.equal(r2.categoryId, null);
  // 生成结果拒绝归类
  await assert.rejects(store.updateAssetCategory(u.userId, gen.id, cat.id), (e) => e.code === 'INPUT_INVALID');
});

test('分类改名：不影响已归类素材', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const cat = await store.createCategory(u.userId, '旧名');
  const renamed = await store.renameCategory(u.userId, cat.id, '新名');
  assert.equal(renamed.name, '新名');
  assert.equal(renamed.id, cat.id, '改名不改 ID');
  // 空名拒绝
  await assert.rejects(store.renameCategory(u.userId, cat.id, '  '), (e) => e.code === 'INPUT_INVALID');
});

test('G02：自指承接被拒绝', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p = await store.createProject(u.userId, '项目');
  await store.updateProject(u.userId, p.id, 1, { nodes: [{ id: 'node-a', kind: 'image', userInput: 'A' }], referenceEdges: [] });
  await assert.rejects(
    store.resolvePredecessor(u.userId, { projectId: p.id, nodeId: 'node-a', context: { enabled: true, sourceNodeId: 'node-a' } }),
    (e) => e.code === 'CONTEXT_SOURCE_INVALID'
  );
});

test('G02：循环承接被拒绝', async (t) => {
  const { store } = await fixture(t);
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p = await store.createProject(u.userId, '项目');
  // a→b（b承a），b→a（a承b）= 环
  await store.updateProject(u.userId, p.id, 1, {
    nodes: [{ id: 'a', kind: 'image', userInput: 'A' }, { id: 'b', kind: 'image', userInput: 'B' }],
    referenceEdges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
  });
  await assert.rejects(
    store.resolvePredecessor(u.userId, { projectId: p.id, nodeId: 'b', context: { enabled: true, sourceNodeId: 'a' } }),
    (e) => e.code === 'CONTEXT_SOURCE_INVALID'
  );
});
