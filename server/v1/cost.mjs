// 镜流 B2：费用估算模块（D12 —— 可配置占位估算，标注"待验"，不沿用旧 0.3 固定价）
// 真实价格需供应商官方文档/实测后校准，本模块提供按阶段的估算框架。

// 阶段成本系数（待验占位，单位：人民币元）。真实值上线前必须由官方文档/实测替换。
const PHASE_COST = {
  validation: 0,
  context_analysis: 0.0,      // 视觉分析，暂按 0（待供应商定价）
  prompt_composition: 0.0,    // 文本组织，暂按 0
  media_generation: 0.3,       // 媒体生成，占位值，待验
  result_storage: 0,
};

// 按模型/类型的估算函数。返回 { estimate, phases, available }
export function estimateCost({ kind, model, mediaReferences = [] }) {
  const phases = { ...PHASE_COST };
  // 多参考可能影响成本（占位：有参考时媒体生成成本可能更高，暂不细分，保留结构）
  const base = kind === 'video' ? PHASE_COST.media_generation : PHASE_COST.media_generation;
  const estimate = Number((base).toFixed(2));
  return {
    estimate,
    phases,
    available: true,   // 仍返回 true 但 estimate 为占位值，真实校验在 B4 接供应商后
    note: '占位估算，真实价格待供应商校准',
  };
}

// 汇总一个任务在各阶段的预留/实际，供额度对账
export function summarizeCharges(task) {
  return {
    estimate: task.estimatedCost ?? 0,
    actual: task.actualCost ?? null,
    reserved: task.reservedCost ?? 0,
    phases: task.costPhases ?? {},
  };
}
