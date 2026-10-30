// 镜流：真实供应商执行器（火山方舟）
// 职责：真实调用豆包 seedream 生图、seed 系列视觉理解，不做 mock、不空产物成功。

import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiError } from './store.mjs';
import ffmpegStatic from 'ffmpeg-static';

// 生图：文生图（无参考）走 /images/generations，返回 data[0].url 或 b64_json。
// 图生图（有参考）seedream 也走 generations 但需按供应商能力；首版先支持文生图。
export async function generateImage({ apiKey, baseUrl, model, prompt, size, referenceImages = [], fetcher = fetch, timeout = 300000 }) {
  if (!apiKey) throw new ApiError('CONFIG', '未配置生图密钥。', 409);
  if (!model) throw new ApiError('CONFIG', '未配置生图模型。', 409);

  const base = (baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const url = base + '/images/generations';
  const body = { model, prompt, size, n: 1 };

  // 参考图：seedream 图生图。火山 seedream 图生图通过 image 字段传参考图（base64 data URL）。
  // 真实能力与多图上限待实测定格（Codex 反馈第 4 条：不能宣称多参考已真实完成）。
  if (referenceImages && referenceImages.length > 0) {
    // 单图参考：用 image 字段；多图是否支持由能力声明约束，不擅自放大
    body.image = referenceImages[0].dataUrl;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = '';
      try { detail = await response.text(); } catch {}
      if (response.status === 401 || response.status === 403) {
        throw new ApiError('PROVIDER', '生图接口认证失败，请检查密钥。');
      }
      // ModelNotOpen 等 → 明确提示，不伪装成功
      const modelNotOpen = /ModelNotOpen|not activated/i.test(detail);
      if (modelNotOpen) throw new ApiError('PROVIDER', '该生图模型未开通，请在火山方舟控制台激活。');
      throw new ApiError('PROVIDER', `生图接口返回 ${response.status}：${detail.slice(0, 200)}`);
    }
    const raw = await response.text();
    if (raw.length > 60_000_000) throw new ApiError('UNCERTAIN', '模型返回内容过大。');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new ApiError('UNCERTAIN', '模型返回格式异常。'); }
    const item = parsed?.data?.[0];
    if (!item) throw new ApiError('UNCERTAIN', '模型未返回可用图片。');

    let bytes;
    if (item.b64_json) {
      bytes = Buffer.from(item.b64_json, 'base64');
    } else if (item.url) {
      const u = new URL(item.url);
      if (u.protocol !== 'https:') throw new ApiError('UNCERTAIN', '服务商返回的图片链接无效。');
      const r = await fetcher(u, { signal: controller.signal });
      if (!r.ok) throw new ApiError('UNCERTAIN', '模型已返回结果，但图片下载失败。');
      bytes = Buffer.from(await r.arrayBuffer());
    } else {
      throw new ApiError('UNCERTAIN', '模型未返回可用图片。');
    }
    if (bytes.length === 0 || bytes.length > 40_000_000) throw new ApiError('UNCERTAIN', '返回图片非法或超过大小限制。');
    return { bytes, mime: 'image/jpeg', ext: 'jpg' };
  } finally {
    clearTimeout(timer);
  }
}

// 视觉理解：真实调用豆包 seed 系列多模态模型，看图输出结构化描述。
// 用于镜流核心功能"相邻镜头视觉承接"：提取前序画面的人物/物体/服装/场景等信息。
export async function analyzeImageWithVision({ apiKey, baseUrl, model, imageUrl, imageUrls, prompt, fetcher = fetch, timeout = 120000 }) {
  if (!apiKey) throw new ApiError('CONFIG', '未配置视觉理解密钥。', 409);
  if (!model) throw new ApiError('CONFIG', '未配置视觉理解模型。', 409);
  const urls = imageUrls && imageUrls.length > 0 ? imageUrls : (imageUrl ? [imageUrl] : []);
  if (urls.length === 0) throw new ApiError('INPUT_INVALID', '缺少待分析的画面。', 400);

  const base = (baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const contentParts = [
    { type: 'text', text: prompt || '请观察这些画面，用于后续镜头的视觉衔接。严格分三段输出：【观察到的】只写画面里确实可见的事实（人物/物体、服装、颜色、位置关系、场景、表现风格）；【推测的】基于观察但不确定的部分，明确标明是推测；【无法确定的】无法确认的内容。不要把推测写成事实，不要补画面里不存在的东西。' },
  ];
  for (const u of urls) {
    contentParts.push({ type: 'image_url', image_url: { url: u } });
  }
  const body = {
    model,
    messages: [{
      role: 'user',
      content: contentParts,
    }],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = '';
      try { detail = await response.text(); } catch {}
      if (response.status === 401 || response.status === 403) throw new ApiError('PROVIDER', '视觉理解接口认证失败。');
      throw new ApiError('PROVIDER', `视觉理解接口返回 ${response.status}：${detail.slice(0, 200)}`);
    }
    const parsed = await response.json();
    const content = parsed?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') throw new ApiError('UNCERTAIN', '视觉理解未返回有效内容。');
    return {
      summary: content,
      uncertainFields: [],
      analyzedAt: new Date().toISOString(),
      analyzerVersion: model,
      hadInput: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

// 视频末尾抽帧（PRD MEM-03）：默认取末尾 2 秒，不足 2 秒取全长。
// 用 ffmpeg 抽关键帧；无 ffmpeg 时明确报错，不静默降级。
// 注：稀疏帧仅作为视觉衔接参考，不等同于完整运动理解（PRD 第 9 节）。
export async function extractVideoFrames({ videoPath, durationSec, outDir, maxFrames = 3, ffmpegPath = null }) {
  // 优先用传入的 ffmpeg 路径（测试注入），否则用 ffmpeg-static，再回退系统 ffmpeg 命令。
  const ffmpegBin = ffmpegPath || ffmpegStatic || 'ffmpeg';

  const start = durationSec < 2 ? 0 : durationSec - 2;
  const end = durationSec;
  const span = Math.max(0.1, end - start);
  const fps = Math.min(2, Math.max(0.5, maxFrames / span));

  const outPattern = path.join(outDir, 'frame-%02d.jpg');
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin, ['-ss', String(start), '-i', videoPath, '-t', String(span), '-vf', `fps=${fps}`, '-q:v', '2', outPattern]);
    let err = '';
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', reject);
    p.on('exit', (code) => code === 0 ? resolve() : reject(new ApiError('UNCERTAIN', '视频抽帧失败：' + err.slice(-200))));
  });
  return { start, end, span, fps };
}

function executableExists(name) {
  return new Promise((resolve) => {
    const p = spawn('sh', ['-c', `command -v ${name} >/dev/null 2>&1`]);
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

// 读取视频真实时长（秒）。用 ffmpeg -i 解析 stderr 里的 Duration，零额外依赖。
// 返回数字（秒），读不到时返回 null（由调用方回退默认值）。
export async function probeVideoDuration(videoPath, ffmpegPath = null) {
  const bin = ffmpegPath || ffmpegStatic || 'ffmpeg';
  return new Promise((resolve) => {
    const p = spawn(bin, ['-i', videoPath]);
    let err = '';
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', () => resolve(null));
    p.on('exit', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return resolve(null);
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      resolve(sec > 0 ? sec : null);
    });
  });
}

// ===== 阿里云百炼万相视频（DashScope 原生异步接口）=====
// 生成地址与鉴权用的 compatible-mode models 列表地址不同。

// 提交视频生成任务，返回供应商 task_id（异步）。首帧图生视频 model=wan2.6-i2v-flash。
export async function createVideoTask({ apiKey, baseUrl, model, prompt, imageUrl, resolution, duration, audio, fetcher = fetch, timeout = 60000 }) {
  if (!apiKey) throw new ApiError('CONFIG', '未配置视频生成密钥。', 409);
  if (!model) throw new ApiError('CONFIG', '未配置视频生成模型。', 409);
  if (!imageUrl) throw new ApiError('INPUT_INVALID', '图生视频需要首帧图片。', 400);

  const base = (baseUrl || 'https://dashscope.aliyuncs.com').replace(/\/+$/, '');
  const url = base + '/api/v1/services/aigc/video-generation/video-synthesis';
  const body = {
    model,
    input: {
      prompt: prompt || '',
      img_url: imageUrl,
    },
    parameters: {
      resolution: resolution || '720P',
      duration: duration || 5,
      audio: audio ?? false,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new ApiError('UNCERTAIN', '视频接口返回格式异常。'); }
    if (!response.ok) {
      const code = parsed?.code || parsed?.error?.code;
      const msg = parsed?.message || parsed?.error?.message || text;
      if (response.status === 401 || response.status === 403) throw new ApiError('PROVIDER', '视频接口认证失败。');
      if (/insufficient|balance|quota|余额|欠费/i.test(msg)) throw new ApiError('QUOTA_EXCEEDED', '视频服务余额/配额不足：' + msg.slice(0, 200));
      throw new ApiError('PROVIDER', `视频任务创建失败 ${response.status}：${msg.slice(0, 200)}`);
    }
    // 原生异步接口返回 output.task_id
    const taskId = parsed?.output?.task_id || parsed?.task_id || parsed?.output?.taskId;
    if (!taskId) throw new ApiError('UNCERTAIN', '视频接口未返回任务编号。');
    return { taskId, raw: parsed };
  } finally {
    clearTimeout(timer);
  }
}

// 查询视频任务状态。返回 { status, videoUrl, ... }。
export async function queryVideoTask({ apiKey, baseUrl, taskId, fetcher = fetch, timeout = 60000 }) {
  if (!apiKey || !taskId) throw new ApiError('CONFIG', '缺少视频查询参数。', 409);
  const base = (baseUrl || 'https://dashscope.aliyuncs.com').replace(/\/+$/, '');
  const url = base + '/api/v1/tasks/' + encodeURIComponent(taskId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetcher(url, { method: 'GET', headers: { Authorization: 'Bearer ' + apiKey }, signal: controller.signal });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new ApiError('UNCERTAIN', '视频查询返回格式异常。'); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new ApiError('PROVIDER', '视频查询认证失败。');
      if (response.status === 404) throw new ApiError('UNCERTAIN', '视频任务不存在或已过期。');
      throw new ApiError('PROVIDER', `视频查询失败 ${response.status}`);
    }
    const output = parsed?.output || parsed;
    const status = output?.task_status || output?.status || parsed?.status;
    let videoUrl = output?.video_url || output?.videoUrl;
    if (!videoUrl && Array.isArray(output?.video_url_list)) videoUrl = output.video_url_list[0];
    return { status: String(status || ''), videoUrl, raw: parsed };
  } finally {
    clearTimeout(timer);
  }
}
