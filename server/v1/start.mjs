// 镜流 v1 服务启动入口（独立端口 5196，与旧 5195 并行）
// 用法：node server/v1/start.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { AdminAuth } from './admin.mjs';
import { V1Store } from './store.mjs';
import { GenerationCoordinator } from './generation.mjs';
import { createV1Server } from './index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const directory = path.join(root, 'data');
const v1Dir = path.join(directory, 'v1');

// 读取生图密钥（本机 .env.local / 环境变量）
let imageApiKey = process.env.IMAGE_API_KEY || '';
const secretFile = path.join(root, '.env.local');
try {
  const s = await readFile(secretFile, 'utf8');
  imageApiKey ||= JSON.parse(s.split('\n').find(l => l.startsWith('IMAGE_API_KEY='))?.slice(14) || '""');
} catch (e) { if (e.code !== 'ENOENT') throw e; }

// 读取百炼视频配置（本机 .env.bailian.handoff / 环境变量）
let videoApiKey = process.env.DASHSCOPE_API_KEY || process.env.VIDEO_API_KEY || '';
let videoBaseUrl = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com';
let videoModel = process.env.DASHSCOPE_VIDEO_MODEL || 'wan2.6-i2v-flash';
let videoResolution = process.env.DASHSCOPE_VIDEO_RESOLUTION || '720P';
let videoDuration = Number(process.env.DASHSCOPE_VIDEO_DURATION || 5);
let videoAudio = (process.env.DASHSCOPE_VIDEO_AUDIO || 'false') === 'true';
const bailianFile = path.join(root, '.env.bailian.handoff');
try {
  const s = await readFile(bailianFile, 'utf8');
  const get = (k) => { const m = s.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
  videoApiKey ||= get('DASHSCOPE_API_KEY');
  videoBaseUrl = get('DASHSCOPE_BASE_URL') || videoBaseUrl;
  videoModel = get('DASHSCOPE_VIDEO_MODEL') || videoModel;
  videoResolution = get('DASHSCOPE_VIDEO_RESOLUTION') || videoResolution;
  const dur = get('DASHSCOPE_VIDEO_DURATION'); if (dur) videoDuration = Number(dur);
  const aud = get('DASHSCOPE_VIDEO_AUDIO'); if (aud) videoAudio = aud === 'true';
} catch (e) { if (e.code !== 'ENOENT') throw e; }

const store = new V1Store(v1Dir);
await store.load();
await new AdminAuth(store).bootstrap();

const coordinator = new GenerationCoordinator(store, {
  imageApiKey,
  imageBaseUrl: process.env.IMAGE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
  imageModel: process.env.IMAGE_MODEL || 'doubao-seedream-5-0-flash-260915',
  visionApiKey: process.env.VISION_API_KEY || imageApiKey,
  visionModel: process.env.VISION_MODEL || 'doubao-seed-2-1-pro-260915',
  videoApiKey,
  videoBaseUrl,
  videoModel,
  videoResolution,
  videoDuration,
  videoAudio,
});

// G03：启动时恢复未完成任务队列（queued 重新入队，running 转 uncertain）
await coordinator.restore();

const server = createV1Server({ store, coordinator });
server.listen(5196, '127.0.0.1', () => {
  console.log('镜流 v1 后端已启动：http://127.0.0.1:5196/api/v1');
  console.log('生图密钥：', imageApiKey ? '已配置' : '未配置');
});

process.on('SIGTERM', () => { server.close(); coordinator.close(); });
process.on('SIGINT', () => { server.close(); coordinator.close(); });
