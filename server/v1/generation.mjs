// 镜流 B2/B3：生成任务协调器
// 职责：requestId 幂等（D14）、多参考校验与冻结、任务状态机、费用记录（D12）、
//       视觉承接与风格组装（B3）。
// B2/B3 用 mock 捕获验证不丢参考、状态机与降级；真实媒体生成在接供应商后替换。

import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ApiError } from './store.mjs';
import { estimateCost } from './cost.mjs';
import { composePrompt } from './style.mjs';
import { analyzeVisual, buildContextBlock, canContinueTextOnly } from './context.mjs';
import { generateImage, analyzeImageWithVision, extractVideoFrames, createVideoTask, queryVideoTask, probeVideoDuration } from './providers.mjs';
import { CAPABILITIES } from './capabilities.mjs';

// 生成输入快照摘要，用于幂等比对（同 requestId 同输入 → 原任务；同 requestId 不同输入 → 冲突）
export function inputDigest(input) {
  const canonical = JSON.stringify(input);
  return createHash('sha256').update(canonical).digest('hex');
}

// 校验多参考：role 必须在允许集合内，assetVersionId 必须存在
const ALLOWED_ROLES = new Set(['reference', 'first_frame', 'last_frame']);
export function validateMediaReferences(mediaReferences = [], kind) {
  if (!Array.isArray(mediaReferences)) throw new ApiError('INPUT_INVALID', '参考素材格式错误。', 400);
  for (const ref of mediaReferences) {
    if (!ref || typeof ref.assetVersionId !== 'string') {
      throw new ApiError('INPUT_INVALID', '参考素材缺少有效版本 ID。', 400);
    }
    if (!ALLOWED_ROLES.has(ref.role)) {
      throw new ApiError('UNSUPPORTED_REFERENCE', `不支持的参考角色：${ref.role}。`, 400);
    }
  }
  return mediaReferences;
}

// 任务状态机（包含 B3 的 awaiting_action 与各 phase）
export const VALID_STATUS = new Set(['preparing', 'queued', 'running', 'succeeded', 'failed', 'uncertain', 'cancelled', 'awaiting_action']);
export const PHASES = ['validation', 'context_analysis', 'prompt_composition', 'media_generation', 'result_storage', 'complete'];

export class GenerationCoordinator {
  constructor(store, hooks = {}) {
    this.store = store;
    this.queue = [];
    this.running = 0;
    this.concurrency = 1;
    this.closed = false;
    // 可注入钩子：
    //  - analyzeVisual: async ({predecessor, mediaRef}) => 视觉分析结果|null
    //  - resolvePredecessor: async ({context, kind, projectId}) => 前序信息
    this.hooks = hooks;
    // 供应商配置（由 start 或测试注入）
    this.provider = {
      imageApiKey: hooks.imageApiKey || '',
      imageBaseUrl: hooks.imageBaseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
      imageModel: hooks.imageModel || 'doubao-seedream-5-0-flash-260915',
      visionApiKey: hooks.visionApiKey || hooks.imageApiKey || '',
      visionModel: hooks.visionModel || 'doubao-seed-2-1-pro-260915',
      fetcher: hooks.fetcher || fetch,
      videoApiKey: hooks.videoApiKey || '',
      videoBaseUrl: hooks.videoBaseUrl || 'https://dashscope.aliyuncs.com',
      videoModel: hooks.videoModel || 'wan2.6-i2v-flash',
      videoResolution: hooks.videoResolution || '720P',
      videoDuration: hooks.videoDuration || 5,
      videoAudio: hooks.videoAudio ?? false,
    };
  }

  // G03 修复：服务重启后恢复任务队列。queued 任务重新入队；running 任务转 uncertain（不盲重发）。
  async restore() {
    for (const task of Object.values(this.store.state.tasks)) {
      if (task.status === 'running') {
        task.status = 'uncertain';
        task.error = '服务重启时任务仍在执行，结果待确认；不会自动重新调用模型。';
        task.finishedAt = new Date().toISOString();
        task.updatedAt = task.finishedAt;
      } else if (task.status === 'queued' || task.status === 'preparing') {
        task.status = 'queued';
        this.queue.push(task.id);
      }
    }
    await this.store.persist();
    this.pump();
  }

  // 提交生成：幂等 + 冻结 + 持久化 + 入队
  async submit(ownerId, input) {
    const { requestId, projectId, nodeId } = input;
    if (!requestId || !/^[a-f0-9-]{36}$/i.test(requestId)) {
      throw new ApiError('INPUT', 'requestId 需为有效 UUID。', 400);
    }
    if (typeof projectId !== 'string' || typeof nodeId !== 'string') {
      throw new ApiError('INPUT', '缺少 projectId 或 nodeId。', 400);
    }

    // G02 修复：校验 kind 与未知模型/类型。
    const kind = input.kind === 'video' ? 'video' : 'image';
    if (input.kind && input.kind !== 'image' && input.kind !== 'video') {
      throw new ApiError('INPUT', `不支持的节点类型：${input.kind}。`, 400);
    }

    // 参考素材校验（Codex 复核问题 2/3）：先做结构/role 校验，再按模型能力校验实体归属与数量，不静默丢图
    const mediaReferences = validateMediaReferences(input.mediaReferences, input.kind);
    // 按选定模型的能力限制校验（数量上限、角色、媒体类型）。
    // 模型 fallback 必须按 kind 区分：视频用 videoModel，图片用 imageModel（否则会查错模型清单）。
    const isVideo = (input.kind || 'image') === 'video';
    const fallbackModel = isVideo ? this.provider.videoModel : this.provider.imageModel;
    const modelCaps = (CAPABILITIES[isVideo ? 'videos' : 'images']?.models || [])
      .find(m => m.id === (input.model || fallbackModel));
    const limits = {
      maxCount: modelCaps?.referenceCount ?? 0,
      allowedRoles: modelCaps?.referenceRoles ?? [],
      allowedMimes: isVideo ? ['image/png', 'image/jpeg', 'image/webp'] : ['image/png', 'image/jpeg', 'image/webp'],
    };
    await this.store.validateReferences(ownerId, mediaReferences, limits);
    // 图生视频：必须在提交阶段校验有 first_frame 首帧参考（付费调用前拒绝，不把承接来源当首帧）。
    if (isVideo && !mediaReferences.some((r) => r.role === 'first_frame')) {
      throw new ApiError('INPUT_INVALID', '图生视频需要用户选择首帧图片。', 400);
    }
    const frozenInput = {
      kind: input.kind || 'image',
      text: input.text ?? null,
      mediaReferences,
      context: input.context ?? { enabled: false },
      style: input.style ?? { presetId: null, customDescription: null },
      model: input.model ?? null,
      size: input.size ?? null,
      parameters: input.parameters ?? {},
    };
    const digest = inputDigest(frozenInput);

    // 注：承接的同类型校验与前序解析均在 execute 阶段由服务端 store.resolvePredecessor 完成，
    // 不在此处信任前端 predecessorKind（Codex 反馈第 3 条）。

    // 幂等：检查同 requestId 是否已存在（用规范化后的 digest 比对）
    const existing = Object.values(this.store.state.tasks).find((t) => t.ownerId === ownerId && t.requestId === requestId);
    if (existing) {
      if (existing.inputDigest === digest) {
        return { task: existing, replayed: true };
      }
      throw new ApiError('CONFLICT', '同一 requestId 的输入已变化，请使用新的 requestId。', 409);
    }

    // 费用估算（D12 占位）
    const cost = estimateCost({ kind: frozenInput.kind, model: input.model, mediaReferences });

    // 额度校验（B4）：预算>0 时检查，超限回落 QUOTA_EXCEEDED
    // 额度校验（G04）：预算>0 时检查（含 reserved），超限回落 QUOTA_EXCEEDED
    await this.store.checkQuota(ownerId, cost.estimate);
    // G04：提交时原子预留额度（排队占用）
    await this.store.reserveQuota(ownerId, cost.estimate);

    // G02 修复：承接开启但未指定来源节点 → 拒绝，不静默跳过。
    if (frozenInput.context && frozenInput.context.enabled && !frozenInput.context.sourceNodeId) {
      throw new ApiError('CONTEXT_SOURCE_INVALID', '承接已开启但未指定来源节点。', 400);
    }

    // 承接前序冻结（Codex 复核问题 1）：在提交时立即解析并冻结前序的真实版本与原文，
    // 之后 execute/重试不再回读可变节点，避免排队期间 A 被改导致 B 承接内容变化。
    let predecessorSnapshot = null;
    if (frozenInput.context && frozenInput.context.enabled && frozenInput.context.sourceNodeId) {
      const resolved = await this.store.resolvePredecessor(ownerId, {
        projectId,
        nodeId,
        context: frozenInput.context,
      });
      if (resolved.predecessor) {
        predecessorSnapshot = {
          sourceNodeId: resolved.predecessor.id,
          sourceKind: resolved.predecessor.kind,
          sourceVersionId: resolved.predecessor.adoptedVersionId ?? null,
          sourcePrompt: resolved.predecessor.originalPrompt ?? null,
          adoptedVersion: resolved.predecessor.adoptedVersion ?? null,
          usedExplicitVersion: !!resolved.predecessor.usedExplicitVersion,
        };
      }
    }

    const task = await this.store.createTask(ownerId, {
      requestId,
      projectId,
      projectRevision: input.projectRevision,
      nodeId,
      inputDigest: digest,
      frozenInput,
      predecessorSnapshot,
      status: 'queued',
      phase: 'validation',
      estimatedCost: cost.estimate,
      costPhases: cost.phases,
      reservedCost: cost.estimate,
      actualCost: null,
      error: null,
      allowedActions: [],
    });

    // 入队（B2 用 mock 执行器，不真实调模型）
    this.queue.push(task.id);
    this.pump();
    return { task, replayed: false };
  }

  // 执行：B2 用 fetcher mock 验证请求捕获不丢参考；B3 换成真实供应商
  async pump() {
    if (this.closed) return;
    while (this.running < this.concurrency && this.queue.length > 0) {
      const taskId = this.queue.shift();
      const task = this.store.state.tasks[taskId];
      if (!task) continue;
      this.running++;
      this.execute(task).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  async execute(task, { continueTextOnly = false } = {}) {
    try {
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      task.phase = 'validation';
      await this.store.persist();

      const input = task.frozenInput;
      // 视频分析窗口初始为 null；视频承接抽帧成功时会被赋真实区间。
      task.videoAnalysisWindow = null;

      // ---- phase 1: context_analysis -------
      task.phase = 'context_analysis';
      await this.store.persist();
      let visualAnalysis = null;
      if (input.context && input.context.enabled) {
        // 前序已在 submit 时冻结进 task.predecessorSnapshot，execute 不再回读可变节点。
        // （Codex 复核问题 1：排队期间 A 被改，不应改变 B 的承接内容）
        const snap = task.predecessorSnapshot;
        const predecessor = snap ? {
          id: snap.sourceNodeId,
          kind: snap.sourceKind,
          originalPrompt: snap.sourcePrompt,
          adoptedVersionId: snap.sourceVersionId,
          adoptedVersion: snap.adoptedVersion,
        } : null;
        const predecessorText = predecessor?.originalPrompt ?? null;

    // 视觉分析：优先真实调用 seed 视觉模型；测试注入 analyzer 时走占位逻辑。
        if (!continueTextOnly && !task.skipVisualAnalysis) {
          const adopted = predecessor?.adoptedVersion;
          // Codex 反馈第 5 条：承接开启但前序无采用结果（无画面可分析）时，
          // 不静默降级，明确进入 awaiting_action 让用户选择（采用结果 or 仅文字继续）。
          if (!adopted || !adopted.filename) {
            const ctext = canContinueTextOnly({ predecessorText, visualAnalysis: null });
            task.status = 'awaiting_action';
            task.phase = 'context_analysis';
            task.error = '前一镜头没有可分析的采用结果画面。';
            task.allowedActions = ['retry_preparation', 'cancel'];
            if (ctext.allowed) task.allowedActions.push('continue_text_only');
            task.predecessorText = predecessorText;
            task.finishedAt = new Date().toISOString();
            task.updatedAt = task.finishedAt;
            await this.store.persist();
            return;
          }
          try {
            // 真实视觉分析：从前序采用版读取画面 → 喂给 seed 视觉模型
            if (!this.hooks.analyzeVisual) {
              const isVideo = (adopted.mime || '').includes('video') || (adopted.ext === 'mp4');
              if (isVideo) {
                // 视频承接（G07）：读真实时长，抽末尾 1-2 秒多帧，综合分析动作与结束状态。
                const videoPath = path.join(this.store.filesDir, adopted.filename);
                // 真实时长：优先 probeVideoDuration，回退节点配置或默认 5 秒
                const probed = await probeVideoDuration(videoPath);
                const durationSec = probed ?? adopted.durationSec ?? input.videoDurationSec ?? 5;
                const tmp = await mkdtemp(path.join(os.tmpdir(), 'jingliu-frames-'));
                try {
                  const win = await extractVideoFrames({ videoPath, durationSec, outDir: tmp, maxFrames: 3 });
                  // 读取抽出的所有帧，转 base64，多帧一起喂视觉模型综合分析
                  const frames = (await readdir(tmp)).filter((f) => f.endsWith('.jpg')).sort();
                  if (frames.length === 0) throw new ApiError('UNCERTAIN', '视频抽帧未得到有效画面。');
                  const frameDataUrls = [];
                  for (const f of frames) {
                    const b = await readFile(path.join(tmp, f));
                    frameDataUrls.push(`data:image/jpeg;base64,${b.toString('base64')}`);
                  }
                  visualAnalysis = await analyzeImageWithVision({
                    apiKey: this.provider.visionApiKey,
                    baseUrl: this.provider.imageBaseUrl,
                    model: this.provider.visionModel,
                    imageUrls: frameDataUrls,
                    prompt: `这是前一镜头末尾约 ${(win.end - win.start).toFixed(1)} 秒的连续画面帧（按时间顺序，共 ${frames.length} 帧，是稀疏采样，不代表完整连续动作）。请严格按以下三段输出：\n\n【观察到的】只描述这些帧里确实可见的事实：人物/物体、服装、位置关系、场景、以及从第1帧到最后一帧能确切看到的位置/姿态变化与变化方向。\n\n【推测的】基于观察但可能不成立的部分，明确说明是推测。\n\n【无法确定的】无法从这些稀疏帧确认的内容，特别是：动作是否已经结束、是否静止。注意——最后一帧的姿态不等于动作已经结束；只有当你能看到多帧之间完全没有位置变化时，才能说“静止/停止”；如果帧与帧之间仍有明显位移，即使最后一帧看似定格，也必须标注为“仍在运动，结束状态无法确定”，不要臆造“静止”或“已结束”。`,
                    fetcher: this.provider.fetcher,
                  });
                  task.videoAnalysisWindow = win;
                  task.frameCount = frames.length;
                } finally {
                  await rm(tmp, { recursive: true, force: true }).catch(() => {});
                }
              } else {
                const bytes = await readFile(path.join(this.store.filesDir, adopted.filename));
                const mime = adopted.mime || 'image/jpeg';
                const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
                visualAnalysis = await analyzeImageWithVision({
                  apiKey: this.provider.visionApiKey,
                  baseUrl: this.provider.imageBaseUrl,
                  model: this.provider.visionModel,
                  imageUrl: dataUrl,
                  fetcher: this.provider.fetcher,
                });
              }
            } else {
              visualAnalysis = await analyzeVisual({
                predecessor,
                mediaRef: input.mediaReferences.find((r) => r.role === 'reference' || r.role === 'first_frame') ?? null,
                analyzer: this.hooks.analyzeVisual,
              });
            }
          } catch (e) {
            if (e instanceof ApiError && (e.code === 'CONTEXT_ANALYSIS_FAILED' || e.code === 'PROVIDER' || e.code === 'CONFIG' || e.code === 'UNCERTAIN')) {
              const ctext = canContinueTextOnly({ predecessorText, visualAnalysis: null });
              task.status = 'awaiting_action';
              task.phase = 'context_analysis';
              task.error = e.message;
              task.allowedActions = ['retry_preparation', 'cancel'];
              if (ctext.allowed) task.allowedActions.push('continue_text_only');
              task.predecessorText = predecessorText;
              task.finishedAt = new Date().toISOString();
              task.updatedAt = task.finishedAt;
              await this.store.persist();
              return;
            }
            throw e;
          }
        }

        // 无文字也无有效视觉 → 拒绝无依据承接（PRD D3）
        const ctext = canContinueTextOnly({ predecessorText, visualAnalysis });
        const hasVisual = !!(visualAnalysis && visualAnalysis.hadInput);
        if (!ctext.hasText && !hasVisual) {
          task.status = 'awaiting_action';
          task.phase = 'context_analysis';
          task.error = '未找到可用的前序文字或视觉输入，无法承接。';
          task.allowedActions = ['cancel'];
          task.finishedAt = new Date().toISOString();
          task.updatedAt = task.finishedAt;
          await this.store.persist();
          return;
        }

        // 组装上下文块
        const contextBlock = buildContextBlock({ context: input.context, predecessorText, visualAnalysis });
        task.contextBlock = contextBlock;
        // 注意：task.videoAnalysisWindow 已在视频分支（抽帧成功处）赋值真实区间，
        // 这里不再用 videoDurationSec 重新计算覆盖（否则会因 frozenInput 无该字段而被置 null，G07）。
      }

      // ---- phase 2: prompt_composition -------
      task.phase = 'prompt_composition';
      await this.store.persist();
      const composed = composePrompt({
        currentText: input.text ?? '',
        style: input.style,
        context: task.contextBlock,
        kind: input.kind,
      });
      task.composedPrompt = composed.finalText;
      task.stylePart = composed.stylePart;

      // ---- phase 3: media_generation （真实供应商调用） -------
      task.phase = 'media_generation';
      task.sentAt = new Date().toISOString();
      await this.store.persist();

      if (input.kind === 'image') {
        // 读取参考素材（mediaReferences）真实字节 → base64 data URL（Codex 复核问题 3：不静默丢图）
        const referenceImages = [];
        for (const ref of (input.mediaReferences || [])) {
          const v = this.store.state.assetVersions[ref.assetVersionId];
          if (!v || v.ownerId !== task.ownerId || !v.filename) {
            throw new ApiError('INPUT_INVALID', `参考素材 ${ref.assetVersionId} 无效或不可读。`, 400);
          }
          const refBytes = await readFile(path.join(this.store.filesDir, v.filename));
          referenceImages.push({
            role: ref.role || 'reference',
            mime: v.mime || 'image/jpeg',
            dataUrl: `data:${v.mime || 'image/jpeg'};base64,${refBytes.toString('base64')}`,
          });
        }
        // 真实生图：调火山 seedream，拿到真实字节
        const result = await generateImage({
          apiKey: this.provider.imageApiKey,
          baseUrl: this.provider.imageBaseUrl,
          model: input.model || this.provider.imageModel,
          prompt: task.composedPrompt,
          size: input.size || '1024x1024',
          referenceImages,
          fetcher: this.provider.fetcher,
        });
        // 落盘为真实资产
        const assetVersion = await this.store.createAsset(task.ownerId, {
          projectId: task.projectId,
          kind: 'generated',
          mime: result.mime,
          ext: result.ext,
          name: task.nodeId || '生成结果',
          bytes: result.bytes,
          nodeId: task.nodeId,
          taskId: task.id,
          sourceText: input.text ?? null,
        });
        task.result = {
          url: `/api/v1/assets/${assetVersion.id}/content`,
          assetVersionId: assetVersion.id,
          mime: result.mime,
        };
      } else {
        // 生视频（G05）：真实调用百炼万相 wan，图生视频。
        // 首帧图：必须来自用户主动选择的 mediaReferences（role=first_frame），
        // 缺首帧直接拒绝，不自动把承接来源的前序画面当成模型参考（Codex 交接第2节）。
        let firstFrameDataUrl = null;
        for (const ref of (input.mediaReferences || [])) {
          if (ref.role !== 'first_frame') continue;
          const v = this.store.state.assetVersions[ref.assetVersionId];
          if (v && v.ownerId === task.ownerId && v.filename) {
            const b = await readFile(path.join(this.store.filesDir, v.filename));
            firstFrameDataUrl = `data:${v.mime || 'image/jpeg'};base64,${b.toString('base64')}`;
            break;
          }
        }
        if (!firstFrameDataUrl) throw new ApiError('INPUT_INVALID', '图生视频需要用户选择首帧图片。', 400);

        // 节点参数（resolution/duration/audio）：优先用 input.parameters，回退服务端默认。
        const resolution = input.parameters?.resolution || this.provider.videoResolution;
        const duration = Number(input.parameters?.duration || this.provider.videoDuration);
        const audio = input.parameters?.audio ?? this.provider.videoAudio;

        // 提交异步视频任务，拿到供应商 task_id 并立即持久化
        const created = await createVideoTask({
          apiKey: this.provider.videoApiKey,
          baseUrl: this.provider.videoBaseUrl,
          model: this.provider.videoModel,
          prompt: task.composedPrompt,
          imageUrl: firstFrameDataUrl,
          resolution,
          duration,
          audio,
          fetcher: this.provider.fetcher,
        });
        task.providerTaskId = created.taskId;
        task.phase = 'media_generation';
        await this.store.persist();

        // 轮询查询，直到成功/失败
        let videoUrl = null;
        let videoBytes = null;
        const pollInterval = 5000;
        const maxPolls = 120; // 最多约 10 分钟
        for (let i = 0; i < maxPolls; i++) {
          await new Promise((r) => setTimeout(r, pollInterval));
          const q = await queryVideoTask({ apiKey: this.provider.videoApiKey, baseUrl: this.provider.videoBaseUrl, taskId: created.taskId, fetcher: this.provider.fetcher });
          const st = q.status.toLowerCase();
          if (st === 'succeeded' || st === 'success') { videoUrl = q.videoUrl; break; }
          if (st === 'failed' || st === 'canceled' || st === 'cancelled' || st === 'expired') {
            throw new ApiError('PROVIDER', '视频生成失败：' + (q.raw?.message || q.raw?.output?.message || st));
          }
        }
        if (!videoUrl) throw new ApiError('UNCERTAIN', '视频生成超时，结果待确认。');

        // 下载视频
        const vr = await this.provider.fetcher(videoUrl, {});
        if (!vr.ok) throw new ApiError('UNCERTAIN', '视频已生成但下载失败。');
        videoBytes = Buffer.from(await vr.arrayBuffer());
        if (videoBytes.length === 0 || videoBytes.length > 200_000_000) throw new ApiError('UNCERTAIN', '视频文件非法或过大。');

        // 落盘为真实资产
        const assetVersion = await this.store.createAsset(task.ownerId, {
          projectId: task.projectId,
          kind: 'generated',
          mime: 'video/mp4',
          ext: 'mp4',
          name: task.nodeId || '生成视频',
          bytes: videoBytes,
          nodeId: task.nodeId,
          taskId: task.id,
          sourceText: input.text ?? null,
        });
        task.result = {
          url: `/api/v1/assets/${assetVersion.id}/content`,
          assetVersionId: assetVersion.id,
          mime: 'video/mp4',
        };
      }

      // ---- phase 4: result_storage / complete -------
      task.phase = 'complete';
      task.status = 'succeeded';
      task.actualCost = task.estimatedCost ?? 0;
      task.finishedAt = new Date().toISOString();
      task.updatedAt = task.finishedAt;
    } catch (e) {
      task.status = e instanceof ApiError ? 'failed' : 'uncertain';
      task.error = e.message || '生成失败';
      task.finishedAt = new Date().toISOString();
    }
    // G04：统一结算额度——释放预留；成功（或已发送）时把预留转为实际消耗入账。
    await this.store.releaseQuota(task.ownerId, task.estimatedCost ?? 0);
    if (task.status === 'succeeded' || task.sentAt) {
      await this.store.recordUsage(task.ownerId, task.estimatedCost ?? 0);
    }
    task.updatedAt = new Date().toISOString();
    await this.store.persist();
  }

  // B3 action 处理：retry_preparation / continue_text_only / cancel
  // 幂等语义（Codex 反馈第 7 条）：先查 actionId 是否已处理，网络重试直接返回原结果，不重复执行。
  async act(ownerId, taskId, { action, actionId }) {
    const task = this.store.state.tasks[taskId];
    if (!task || task.ownerId !== ownerId) throw new ApiError('NOT_FOUND', '任务不存在。', 404);

    // 幂等重放：同一 actionId 已处理过 → 返回当时结果，不重复执行（不依赖当前状态）
    if (actionId && task.actionLog && task.actionLog[actionId]) {
      return { task: structuredClone(task), replayed: true, actionResult: task.actionLog[actionId] };
    }

    // 校验 action 合法性
    if (!['cancel', 'continue_text_only', 'retry_preparation'].includes(action)) {
      throw new ApiError('INPUT', `不支持的动作：${action}。`, 400);
    }
    if (task.status !== 'awaiting_action') {
      throw new ApiError('STATE', '任务当前不允许此操作。', 409);
    }

    const key = actionId ?? randomUUID();
    let actionResult;

    if (action === 'cancel') {
      task.status = 'cancelled';
      task.updatedAt = new Date().toISOString();
      task.error = '已取消。';
      actionResult = { status: 'cancelled' };
    } else if (action === 'continue_text_only') {
      if (!task.allowedActions.includes('continue_text_only')) {
        throw new ApiError('STATE', '此任务无前序文字，不能仅文字继续。', 409);
      }
      task.status = 'queued';
      task.phase = 'context_analysis';
      task.skipVisualAnalysis = true;
      actionResult = { status: 'queued', skipVisualAnalysis: true };
    } else if (action === 'retry_preparation') {
      task.status = 'queued';
      task.phase = 'context_analysis';
      task.skipVisualAnalysis = false;
      actionResult = { status: 'queued', skipVisualAnalysis: false };
    }

    // 记录幂等结果
    if (!task.actionLog) task.actionLog = {};
    task.actionLog[key] = actionResult;
    await this.store.persist();

    // 继续执行（继续文字/重试才入队）
    if (action !== 'cancel') {
      this.queue.push(task.id);
      this.pump();
    }
    return { task, replayed: false, actionResult };
  }

  // 等待所有运行中的任务完成（用于测试清理和优雅关闭）
  async waitIdle(timeoutMs = 5000) {
    const start = Date.now();
    while (this.running > 0 || this.queue.length > 0) {
      if (Date.now() - start > timeoutMs) throw new Error('协调器未在超时内空闲');
      await new Promise((r) => setTimeout(r, 5));
    }
    await this.store.flush();
  }

  async close() {
    this.closed = true;
    await this.waitIdle();
  }
}
