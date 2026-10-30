// 镜流 B3：相邻记忆承接与视觉处理
// PRD MEM-01 ~ MEM-06 + 交接文档第 6 节业务约束。
// 职责：同类型单前序校验、视觉分析记录（含不确定性）、分析失败降级到 awaiting_action。

import { ApiError } from './store.mjs';

// 视频默认分析末尾 2 秒，不足 2 秒取全长（PRD MEM-03 / D1）
export function videoAnalysisWindow(durationSec) {
  if (typeof durationSec !== 'number' || durationSec <= 0) return null;
  return durationSec < 2 ? { start: 0, end: durationSec, full: true } : { start: durationSec - 2, end: durationSec, full: false };
}

// 校验承接关系：同类型单前序（图片承图片、视频承视频）
export function validateContext({ context, currentNodeKind, predecessorKind }) {
  if (!context || !context.enabled) return { enabled: false, sourceNodeId: null, sourceVersionId: null };

  const sourceNodeId = context.sourceNodeId;
  if (!sourceNodeId) {
    throw new ApiError('CONTEXT_SOURCE_INVALID', '承接已开启但未指定来源节点。', 400);
  }
  if (sourceNodeId === context.selfNodeId) {
    throw new ApiError('CONTEXT_SOURCE_INVALID', '承接不能指向自身。', 400);
  }
  // 同类型约束：图片承图片、视频承视频（PRD MEM-01）
  if (predecessorKind && currentNodeKind && predecessorKind !== currentNodeKind) {
    throw new ApiError('CONTEXT_SOURCE_INVALID', `承接仅支持同类型：${currentNodeKind} 不能承接 ${predecessorKind}。`, 400);
  }
  return { enabled: true, sourceNodeId, sourceVersionId: context.sourceVersionId ?? null };
}

// 生成视觉分析记录（含不确定性标注）。B3 用可注入的分析器，真实视觉理解在接供应商后替换。
// 返回统一结构：{ summary, uncertainFields, analyzedAt, analyzerVersion } 或 null（分析失败）
export async function analyzeVisual({ predecessor, mediaRef, analyzer = null }) {
  // 无视觉输入源时返回 null（允许仅文字继续，但需由上一层决定是否属实）
  if (!predecessor) return null;
  const notes = [];
  if (predecessor.missingText) notes.push('导入素材无原始提示词，仅使用视觉信息。');

  // 默认分析器：B3 阶段不接真实视觉模型，返回"待分析"占位 + 明确不确定性。
  // 真实视觉理解在真实冒烟阶段按 PRD 第 10 节评测，此处不冒充已分析。
  const impl = analyzer || (() => ({
    summary: '视觉分析占位：尚未接入真实视觉模型。',
    uncertainFields: ['人物', '物体', '服装', '位置关系', '场景', '表现风格'],
    analyzedAt: new Date().toISOString(),
    analyzerVersion: 'placeholder-0',
  }));

  let result;
  try {
    result = await impl({ predecessor, mediaRef });
  } catch (e) {
    // 视觉分析器失败 → 统一抛 CONTEXT_ANALYSIS_FAILED（PRD D3：说明原因，可重试/仅文字继续）
    throw new ApiError('CONTEXT_ANALYSIS_FAILED', e?.message || '前一镜头视觉分析失败。', 422, {
      retryable: true,
      allowedActions: ['retry_preparation', 'cancel'],
    });
  }
  if (!result || typeof result !== 'object') {
    // 分析器返回无效结果 → 视为无有效视觉输入（由上层决定是否拒绝无依据承接）
    return null;
  }
  return {
    ...result,
    notes,
    hadInput: true,
  };
}

// 生成承接上下文（用于组装提示词）。前序文字取"对应结果生成时的原始用户描述"，不伪造。
export function buildContextBlock({ context, predecessorText, visualAnalysis }) {
  if (!context || !context.enabled) return null;
  const block = { enabled: true, predecessorText: predecessorText ?? null };
  if (visualAnalysis) {
    block.visual = visualAnalysis.summary;
    block.uncertainFields = visualAnalysis.uncertainFields ?? [];
  }
  return block;
}

// 判断承接是否可"仅文字继续"：只有具备前序文字时才允许（PRD D3 + 接口草案第 5 节）
export function canContinueTextOnly({ predecessorText, visualAnalysis }) {
  const hasText = typeof predecessorText === 'string' && predecessorText.trim().length > 0;
  return { allowed: hasText, hasText };
}

// 分析缓存键：来源版本 + 输入区间 + 模型/规则版本（PRD 第 8 节）
export function analysisCacheKey({ sourceVersionId, window, analyzerVersion }) {
  return JSON.stringify({ sourceVersionId: sourceVersionId ?? null, window: window ?? null, analyzerVersion: analyzerVersion ?? 'placeholder-0' });
}
