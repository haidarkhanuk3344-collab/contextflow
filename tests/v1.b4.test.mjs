import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { V1Store } from '../server/v1/store.mjs';
import { GenerationCoordinator } from '../server/v1/generation.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=';
function mockFetcher() { return async (url) => { if (String(url).endsWith('/images/generations')) return new Response(JSON.stringify({ data: [{ b64_json: PNG }] }), { headers: { 'Content-Type': 'application/json' } }); throw new Error('unexpected ' + url); }; }
function makeCoord(store) { return new GenerationCoordinator(store, { fetcher: mockFetcher(), imageApiKey: 'test-key' }); }

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jingliu-b4-'));
  const store = new V1Store(dir);
  await store.load();
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p = await store.createProject(u.userId, '项目');
  t.after(async () => { await store.flush(); await rm(dir, { recursive: true, force: true }); });
  return { store, u, p };
}

test('额度：预算 0 表示不限额；超限拒绝 QUOTA_EXCEEDED', async (t) => {
  const { store, u, p } = await fixture(t);
  // 默认 budget=0 表示不限额，正常提交
  const coord = makeCoord(store);
  const reqId = 'ccccccc1-2222-3333-4444-555555555555';
  let r = await coord.submit(u.userId, { requestId: reqId, projectId: p.id, nodeId: 'n', kind: 'image', text: 'x', mediaReferences: [], context: {} });
  assert.equal(r.replayed, false);
  await coord.close();

  // 设置极小额度（0.2 元），提交 0.3 元的任务应超限
  await store.setQuota(u.userId, { budget: 0.2 });
  const coord2 = makeCoord(store);
  await assert.rejects(
    coord2.submit(u.userId, { requestId: 'ccccccc2-2222-3333-4444-555555555555', projectId: p.id, nodeId: 'n2', kind: 'image', text: 'y', mediaReferences: [], context: {} }),
    (e) => e.code === 'QUOTA_EXCEEDED'
  );
  await coord2.close();
});

test('额度：成功后记录用量，checkQuota 累计', async (t) => {
  const { store, u, p } = await fixture(t);
  await store.setQuota(u.userId, { budget: 10 });
  const coord = makeCoord(store);
  const { task } = await coord.submit(u.userId, { requestId: 'ccccccc3-2222-3333-4444-555555555555', projectId: p.id, nodeId: 'n', kind: 'image', text: 'x', mediaReferences: [], context: {} });
  await new Promise((r) => setTimeout(r, 20));
  const stats = await store.getStats(u.userId);
  assert.ok(stats.quota.used > 0, '成功后记录用量');
  await coord.close();
});

test('受保护资源：归属校验，越权返回 404', async (t) => {
  const { store, u, p } = await fixture(t);
  const v = await store.createAsset(u.userId, { projectId: p.id, kind: 'upload', mime: 'image/png', ext: 'png', name: '图' });
  // 本人可访问
  const got = await store.getAssetVersion(u.userId, v.id);
  assert.equal(got.id, v.id);
  // 他人越权 → 404
  const u2 = await store.acceptInvite(await store.createInvite(), '乙');
  await assert.rejects(store.getAssetVersion(u2.userId, v.id), (e) => e.code === 'NOT_FOUND');
});
