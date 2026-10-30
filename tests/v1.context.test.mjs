import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { V1Store } from '../server/v1/store.mjs';
import { GenerationCoordinator } from '../server/v1/generation.mjs';
import { composePrompt, composeStyleDirective, STYLE_PRESETS } from '../server/v1/style.mjs';
import { validateContext, videoAnalysisWindow, canContinueTextOnly, analysisCacheKey } from '../server/v1/context.mjs';

async function fixture(t, hooks = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jingliu-b3-'));
  const store = new V1Store(dir);
  await store.load();
  const u = await store.acceptInvite(await store.createInvite(), '甲');
  const p = await store.createProject(u.userId, '项目');
  const mockFetcher = async (url) => {
    if (String(url).endsWith('/images/generations')) return new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=' }] }), { headers: { 'Content-Type': 'application/json' } });
    throw new Error('unexpected ' + url);
  };
  const coord = new GenerationCoordinator(store, { ...hooks, fetcher: mockFetcher, imageApiKey: 'test-key' });
  t.after(async () => { await coord.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, u, p, coord };
}

const reqId = () => 'bbbbbbb1-2222-3333-4444-555555555555';

// 构造一个真实的前序节点（含采用结果可选），返回前序节点 id 和采用版（如有）
async function seedPredecessor(store, u, p, { kind = 'image', prompt = '前序镜头描述', withResult = false } = {}) {
  const srcId = 'src-node';
  let adoptedVersion = null;
  let adoptedId = undefined;
  if (withResult) {
    // 一个合法的最小 JPEG（魔术字节 + 足够长度）
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0), Buffer.from([0xff, 0xd9])]);
    adoptedVersion = await store.createAsset(u.userId, { projectId: p.id, kind: 'generated', mime: 'image/jpeg', ext: 'jpg', name: 'A结果', bytes: jpeg });
    adoptedId = adoptedVersion.id;
  }
  await store.updateProject(u.userId, p.id, 1, {
    nodes: [
      { id: srcId, kind, userInput: prompt, adoptedVersionId: adoptedId },
      { id: 'n1', kind, userInput: '当前描述' },
    ],
    referenceEdges: [{ source: srcId, target: 'n1' }],
  });
  return { srcId, adoptedVersion };
}

test('四风格 composePrompt：预设风格 + 用户要求 + 前序上下文', () => {
  const out = composePrompt({
    currentText: '一名女性站在雨夜街头',
    style: { presetId: 'chinese_2d', customDescription: null },
    context: { enabled: true, predecessorText: '前置：街道远处有人递伞' },
    kind: 'image',
  });
  assert.ok(out.finalText.includes('中式二维'), '包含风格引导');
  assert.ok(out.finalText.includes('前置镜头上下文'), '包含上下文');
  assert.ok(out.finalText.includes('当前镜头任务'), '包含当前要求');
  assert.ok(out.finalText.includes('当前镜头明确描述变化时'), '包含优先级规则');
  assert.equal(out.stylePart.presetId, 'chinese_2d');
});

test('四风格预设版本化，自由风格由自定义描述接管', () => {
  assert.equal(STYLE_PRESETS.chinese_2d.version, 1);
  assert.equal(STYLE_PRESETS.period_realistic.name, '古装真人');
  const free = composeStyleDirective({ presetId: null, customDescription: '赛博朋克霓虹' });
  assert.equal(free.custom, '赛博朋克霓虹');
  assert.equal(free.presetId, null);
});

test('承接校验：同类型允许，跨类型拒绝，未指定来源拒绝', () => {
  assert.doesNotThrow(() => validateContext({ context: { enabled: true, sourceNodeId: 'a', selfNodeId: 'b' }, currentNodeKind: 'video', predecessorKind: 'video' }));
  assert.throws(() => validateContext({ context: { enabled: true, sourceNodeId: 'a', selfNodeId: 'b' }, currentNodeKind: 'image', predecessorKind: 'video' }), (e) => e.code === 'CONTEXT_SOURCE_INVALID');
  assert.throws(() => validateContext({ context: { enabled: true, sourceNodeId: null, selfNodeId: 'b' }, currentNodeKind: 'image', predecessorKind: 'image' }), (e) => e.code === 'CONTEXT_SOURCE_INVALID');
});

test('视频分析窗口：默认末尾2秒，不足2秒取全长', () => {
  assert.deepEqual(videoAnalysisWindow(10), { start: 8, end: 10, full: false });
  assert.deepEqual(videoAnalysisWindow(1.5), { start: 0, end: 1.5, full: true });
});

test('视觉分析失败 → awaiting_action，提供仅文字继续（有前序文字时）', async (t) => {
  const hooks = {
    analyzeVisual: async () => { throw Object.assign(new Error('分析失败'), { code: 'CONTEXT_ANALYSIS_FAILED' }); },
  };
  const { u, p, coord, store } = await fixture(t, hooks);
  const { srcId } = await seedPredecessor(store, u, p, { kind: 'image', withResult: true });
  const { task } = await coord.submit(u.userId, {
    requestId: reqId(), projectId: p.id, nodeId: 'n1', kind: 'image', text: '当前描述',
    mediaReferences: [], context: { enabled: true, sourceNodeId: srcId },
  });
  await coord.waitIdle();
  const t2 = await store.getTask(u.userId, task.id);
  assert.equal(t2.status, 'awaiting_action');
  assert.ok(t2.allowedActions.includes('continue_text_only'), '有前序文字，应允许仅文字继续');
  assert.ok(t2.allowedActions.includes('retry_preparation'));
  assert.ok(t2.allowedActions.includes('cancel'));
});

test('仅文字继续：跳过视觉分析并完成生成', async (t) => {
  const hooks = {
    analyzeVisual: async () => { throw Object.assign(new Error('分析失败'), { code: 'CONTEXT_ANALYSIS_FAILED' }); },
  };
  const { u, p, coord, store } = await fixture(t, hooks);
  const { srcId } = await seedPredecessor(store, u, p, { kind: 'image', withResult: true });
  const { task } = await coord.submit(u.userId, {
    requestId: reqId(), projectId: p.id, nodeId: 'n1', kind: 'image', text: '当前描述',
    mediaReferences: [], context: { enabled: true, sourceNodeId: srcId },
  });
  await coord.waitIdle();
  // 执行 continue_text_only
  await coord.act(u.userId, task.id, { action: 'continue_text_only', actionId: 'act-1' });
  await coord.waitIdle();
  const t2 = await store.getTask(u.userId, task.id);
  assert.equal(t2.status, 'succeeded');
  assert.ok(t2.composedPrompt.includes('前序镜头描述'), '组装了前序文字');
  assert.equal(t2.skipVisualAnalysis, true);
});

test('分析缓存键：绑定来源版本 + 窗口 + 分析器版本', () => {
  const k1 = analysisCacheKey({ sourceVersionId: 'v1', window: { start: 8, end: 10 }, analyzerVersion: 'a1' });
  const k2 = analysisCacheKey({ sourceVersionId: 'v2', window: { start: 8, end: 10 }, analyzerVersion: 'a1' });
  assert.notEqual(k1, k2, '来源版本变化导致缓存失效');
});

test('无文字也无视觉输入时拒绝无依据承接', async (t) => {
  const { u, p, coord, store } = await fixture(t);
  // 前序无文字（prompt 空）且无采用结果 → 拒绝无依据承接
  await store.updateProject(u.userId, p.id, 1, {
    nodes: [
      { id: 'src-node', kind: 'image', userInput: '' },
      { id: 'n1', kind: 'image', userInput: '当前描述' },
    ],
    referenceEdges: [],
  });
  const { task } = await coord.submit(u.userId, {
    requestId: reqId(), projectId: p.id, nodeId: 'n1', kind: 'image', text: '当前描述',
    mediaReferences: [], context: { enabled: true, sourceNodeId: 'src-node' },
  });
  await coord.waitIdle();
  const t2 = await store.getTask(u.userId, task.id);
  assert.equal(t2.status, 'awaiting_action');
  assert.ok(!t2.allowedActions.includes('continue_text_only'), '无前序文字不能仅文字继续');
});

test('actionId 幂等：同 actionId 重试返回原结果，不重复执行（Codex 第7条）', async (t) => {
  const hooks = {
    analyzeVisual: async () => { throw Object.assign(new Error('分析失败'), { code: 'CONTEXT_ANALYSIS_FAILED' }); },
  };
  const { u, p, coord, store } = await fixture(t, hooks);
  const { srcId } = await seedPredecessor(store, u, p, { kind: 'image', withResult: true });
  const { task } = await coord.submit(u.userId, {
    requestId: reqId(), projectId: p.id, nodeId: 'n1', kind: 'image', text: 'x',
    mediaReferences: [], context: { enabled: true, sourceNodeId: srcId },
  });
  await coord.waitIdle();
  // 第一次 action
  const r1 = await coord.act(u.userId, task.id, { action: 'continue_text_only', actionId: 'act-idem-1' });
  assert.equal(r1.replayed, false);
  // 同 actionId 重试 → 应 replayed:true，不重复入队
  const r2 = await coord.act(u.userId, task.id, { action: 'continue_text_only', actionId: 'act-idem-1' });
  assert.equal(r2.replayed, true);
  assert.equal(r2.actionResult.status, 'queued');
  await coord.close();
});

test('G01：视觉摘要真实加入最终提示词', () => {
  const out = composePrompt({
    currentText: '同一个女孩转身微笑',
    style: { presetId: null, customDescription: null },
    context: { enabled: true, predecessorText: '前序原文', visual: '视觉摘要：红色连衣裙' },
    kind: 'image',
  });
  assert.ok(out.finalText.includes('视觉摘要：红色连衣裙'), '视觉摘要应进提示词');
  assert.equal(out.hasVisual, true);
});

test('G01：无可见视觉摘要时不加视觉段', () => {
  const out = composePrompt({
    currentText: 'x',
    style: {},
    context: { enabled: true, predecessorText: '前序原文' },
    kind: 'image',
  });
  assert.equal(out.hasVisual, false);
});

test('多帧视觉分析：analyzeImageWithVision 支持多图输入（G07）', async (t) => {
  const { analyzeImageWithVision } = await import('../server/v1/providers.mjs');
  let capturedBody = null;
  const mockFetcher = async (url, opts) => {
    if (String(url).endsWith('/chat/completions')) {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '多帧综合分析结果' } }] }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected ' + url);
  };
  const r = await analyzeImageWithVision({
    apiKey: 'k', baseUrl: 'https://ark.example.com', model: 'm',
    imageUrls: ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB', 'data:image/jpeg;base64,CCC'],
    fetcher: mockFetcher,
  });
  // 请求体应包含 3 张图 + 1 段文本
  const content = capturedBody.messages[0].content;
  const imgParts = content.filter((c) => c.type === 'image_url');
  assert.equal(imgParts.length, 3, '应包含 3 张图');
  assert.equal(r.summary, '多帧综合分析结果');
  assert.equal(r.hadInput, true);
});

test('probeVideoDuration 读取真实视频时长', async (t) => {
  const { probeVideoDuration } = await import('../server/v1/providers.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { default: ffmpeg } = await import('ffmpeg-static');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'contextflow-video-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'generated.mp4');
  await promisify(execFile)(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64:r=10', '-t', '2', '-pix_fmt', 'yuv420p', file]);
  const d = await probeVideoDuration(file);
  assert.ok(d > 0, '应读到时长为正数');
  assert.ok(d < 10, '2秒视频时长应接近2');
});
