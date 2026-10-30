import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { V1Store } from '../server/v1/store.mjs';
import { GenerationCoordinator, inputDigest, validateMediaReferences } from '../server/v1/generation.mjs';
import { estimateCost } from '../server/v1/cost.mjs';

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=';
// mock 火山生图：返回 1x1 png（验证真实执行器链路，不真实花钱）
function mockImageFetcher() {
  return async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/images/generations')) {
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_1x1 }] }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected url ' + u);
  };
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jingliu-b2-'));
  const store = new V1Store(dir);
  await store.load();
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p = await store.createProject(u.userId, '项目');
  const coord = new GenerationCoordinator(store, { fetcher: mockImageFetcher(), imageApiKey: 'test-key' });
  t.after(async () => { await coord.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, u, p, coord };
}

test('requestId 幂等：同 ID 同输入返回原任务，同 ID 不同输入冲突', async (t) => {
  const { u, p, coord } = await fixture(t);
  const base = { requestId: '11111111-2222-3333-4444-555555555555', projectId: p.id, nodeId: 'node-x', kind: 'image', text: '一只猫', mediaReferences: [], context: { enabled: false } };
  const r1 = await coord.submit(u.userId, { ...base });
  assert.equal(r1.replayed, false);
  const r2 = await coord.submit(u.userId, { ...base });
  assert.equal(r2.replayed, true);
  assert.equal(r1.task.id, r2.task.id, '同输入返回同一任务');
  // 同 ID 不同输入 → 冲突
  await assert.rejects(coord.submit(u.userId, { ...base, text: '一只狗' }), (e) => e.code === 'CONFLICT');
});

test('参考素材：单图不丢，超限按模型能力拒绝', async (t) => {
  const { u, p, coord, store } = await fixture(t);
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(24, 0)]);
  const ref1 = await store.createAsset(u.userId, { projectId: p.id, kind: 'upload', mime: 'image/png', ext: 'png', name: '参考1', bytes: png });
  // 单图参考：不丢
  const reqId1 = 'aaaaaaa1-2222-3333-4444-555555555555';
  const task1 = await coord.submit(u.userId, { requestId: reqId1, projectId: p.id, nodeId: 'node-v', kind: 'image', text: '一段图', mediaReferences: [{ assetVersionId: ref1.id, role: 'reference' }], context: { enabled: false } });
  assert.equal(task1.task.frozenInput.mediaReferences.length, 1);
  // 两个参考：flash 模型 referenceCount=1，应拒绝（不静默丢第二张）
  const ref2 = await store.createAsset(u.userId, { projectId: p.id, kind: 'upload', mime: 'image/png', ext: 'png', name: '参考2', bytes: png });
  const reqId2 = 'aaaaaaa2-2222-3333-4444-555555555555';
  await assert.rejects(
    coord.submit(u.userId, { requestId: reqId2, projectId: p.id, nodeId: 'node-v', kind: 'image', text: '一段图', mediaReferences: [{ assetVersionId: ref1.id, role: 'reference' }, { assetVersionId: ref2.id, role: 'reference' }], context: { enabled: false } }),
    (e) => e.code === 'UNSUPPORTED_REFERENCE'
  );
});

test('费用记录：占位估算写入任务，含 phases 与 note', async (t) => {
  const { u, p, coord } = await fixture(t);
  const cost = estimateCost({ kind: 'image', model: 'gpt-image-2', mediaReferences: [] });
  assert.ok(cost.estimate > 0, '占位估算大于 0');
  assert.ok(cost.note.includes('待'), '标注待验');
  const reqId = 'aaaaaaa2-2222-3333-4444-555555555555';
  const task = await coord.submit(u.userId, { requestId: reqId, projectId: p.id, nodeId: 'n', kind: 'image', text: 'x', mediaReferences: [], context: {} });
  assert.ok(task.task.estimatedCost > 0);
  assert.ok(task.task.costPhases && task.task.costPhases.media_generation > 0);
});

test('状态机：提交后 queued→running→succeeded，含真实结果', async (t) => {
  const { u, p, coord, store } = await fixture(t);
  const reqId = 'aaaaaaa3-2222-3333-4444-555555555555';
  const { task } = await coord.submit(u.userId, { requestId: reqId, projectId: p.id, nodeId: 'n', kind: 'image', text: 'x', mediaReferences: [], context: {} });
  await coord.waitIdle();
  const final = await store.getTask(u.userId, task.id);
  assert.equal(final.status, 'succeeded');
  assert.ok(final.startedAt && final.finishedAt);
  assert.ok(final.result && final.result.assetVersionId, '应返回真实结果 assetVersionId');
});

test('validateMediaReferences 拒绝非法 role', () => {
  assert.throws(() => validateMediaReferences([{ assetVersionId: 'x', role: 'bogus' }], 'image'), (e) => e.code === 'UNSUPPORTED_REFERENCE');
  assert.throws(() => validateMediaReferences([{ role: 'reference' }], 'image'), (e) => e.code === 'INPUT_INVALID');
  assert.doesNotThrow(() => validateMediaReferences([{ assetVersionId: 'x', role: 'first_frame' }], 'video'));
});

test('图生视频：缺首帧参考时拒绝，不把承接来源当首帧（Codex 交接第2节）', async (t) => {
  const { u, p, coord, store } = await fixture(t);
  // 建一个 video 节点任务，无 first_frame 参考，但开启了承接（有前序）→ 仍应拒绝
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(24, 0)]);
  const preAsset = await store.createAsset(u.userId, { projectId: p.id, kind: 'generated', mime: 'image/png', ext: 'png', name: '前序图', bytes: png, nodeId: 'pre' });
  await store.updateProject(u.userId, p.id, 1, {
    nodes: [{ id: 'pre', kind: 'video', userInput: '前序', adoptedVersionId: preAsset.id }, { id: 'cur', kind: 'video', userInput: '当前' }],
    referenceEdges: [],
  });
  await assert.rejects(
    coord.submit(u.userId, {
      requestId: 'ddddddd1-2222-3333-4444-555555555555',
      projectId: p.id, nodeId: 'cur', kind: 'video', text: 'x',
      mediaReferences: [],  // 无 first_frame
      context: { enabled: true, sourceNodeId: 'pre' },  // 有承接，但不应被当首帧
    }),
    (e) => e.code === 'INPUT_INVALID'
  );
});
