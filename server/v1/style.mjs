// 镜流 B3：四风格后台提示词生成（黑盒，不要求用户审阅提示词）
// PRD STYLE-01 ~ STYLE-04：四预设版本化风格配置 + 自由风格由模型理解。
// 规则：用户明确要求优先于模板默认和前序状态；切换风格遵循当前选择（STYLE-04）。

import { ApiError } from './store.mjs';

// 四预设（与 capabilities.mjs 的 STYLES 对应，版本化）
export const STYLE_PRESETS = {
  period_realistic: {
    id: 'period_realistic',
    name: '古装真人',
    version: 1,
    // 后台提示词引导（不返回给用户审阅）
    directive: '写实古装人物，保留人物身份与服装等用户明确约束。',
  },
  modern_realistic: {
    id: 'modern_realistic',
    name: '现代真人',
    version: 1,
    directive: '写实现代人物，保留人物身份与服装等用户明确约束。',
  },
  chinese_2d: {
    id: 'chinese_2d',
    name: '中式二维',
    version: 1,
    directive: '中式二维画风人物，画面表现优先遵循当前风格选择。',
  },
  game_cg: {
    id: 'game_cg',
    name: '游戏CG',
    version: 1,
    directive: '游戏CG质感人物，画面表现优先遵循当前风格选择。',
  },
};

// 生成风格提示词片段（后台黑盒）。
// customDescription 与 presetId 二选一起效；用户明确风格优先于前序画面表现。
export function composeStyleDirective(style) {
  const presetId = style?.presetId ?? null;
  const customDescription = style?.customDescription ?? null;
  if (presetId) {
    const preset = STYLE_PRESETS[presetId];
    if (!preset) throw new ApiError('STYLE_INVALID', `不支持的风格预设：${presetId}。`, 400);
    return { presetId, presetName: preset.name, version: preset.version, directive: preset.directive, custom: null };
  }
  if (customDescription) {
    return { presetId: null, presetName: null, version: null, directive: null, custom: String(customDescription).slice(0, 2000) };
  }
  // 未选风格：不附加风格引导，走普通生成
  return { presetId: null, presetName: null, version: null, directive: null, custom: null };
}

// 组装提示词：用户要求 + 风格引导 + 前序上下文 + 前序视觉摘要（B3 组装阶段使用）
// 规则：当前明确描述变化时以当前要求为准（PRD MEM-05）；视觉摘要真实参与下游生成（G01）。
export function composePrompt({ currentText, style, context = null, kind }) {
  const stylePart = composeStyleDirective(style);
  const parts = [];
  if (kind === 'image') {
    parts.push('本次只生成一张当前镜头的图片，不要生成分镜拼图或前后对比图。');
  } else {
    parts.push('本次只生成当前镜头任务描述的视频。');
  }

  if (context && context.enabled && context.predecessorText) {
    parts.push('前置镜头上下文仅用于理解叙事背景、人物指代和场景关系，不属于本次需要重演的内容。');
    parts.push('当前镜头明确描述变化时，以当前镜头要求为准。');
    parts.push(`【前置镜头上下文】\n${context.predecessorText}`);
  }

  // G01 修复：视觉摘要（前序画面观察）必须加入最终提示词，真实参与下游生成。
  if (context && context.enabled && context.visual) {
    parts.push('【前一镜头画面观察（用于视觉衔接，保留不确定性）】\n' + context.visual);
  }

  if (stylePart.directive) {
    parts.push(`【风格要求】\n${stylePart.directive}`);
  } else if (stylePart.custom) {
    parts.push(`【用户风格描述】\n${stylePart.custom}`);
  }

  parts.push(`【当前镜头任务】\n${currentText}`);
  return { finalText: parts.join('\n\n'), stylePart, hasContext: !!(context && context.enabled && context.predecessorText), hasVisual: !!(context && context.enabled && context.visual) };
}
