// 镜流 B1：模型能力与风格静态声明（供前端 fixture 联调）
// 说明：B0 决策 D13 —— 先静态声明，真实模型能力在 B3 接供应商后校准。

export const CAPABILITIES = {
  // 运行时真实能力声明（Codex 反馈要求）：只有真实实现并验证后才设 true
  runtime: {
    imageGeneration: true,   // 已接真实豆包 seedream 执行器
    videoGeneration: true,   // 已接百炼万相 wan2.6-i2v-flash 图生视频
    assetUpload: true,       // createAsset 已支持真实文件落盘
    context: true,           // 图片承接视觉分析已接真实 seed 视觉模型（视频抽帧待接）
  },
  images: {
    models: [
      { id: 'doubao-seedream-5-0-flash-260915', name: '豆包 Seedream 5.0 Flash', inputKinds: ['text', 'image'], referenceCount: 1, referenceRoles: ['reference'] },
      { id: 'doubao-seedream-5-0-pro-260628', name: '豆包 Seedream 5.0 Pro', inputKinds: ['text', 'image'], referenceCount: 1, referenceRoles: ['reference'] },
      { id: 'doubao-seedream-4-0-20260415', name: '豆包 Seedream 4.0', inputKinds: ['text', 'image'], referenceCount: 1, referenceRoles: ['reference'] },
    ],
    sizes: ['1024x1024', '1536x1024', '1024x1536'],
    costEstimateAvailable: false,
    // 说明：单图参考图生图已真实验证（images/generations + image 字段，input_images:1）。
    // 多图参考未实测定格，故 referenceCount 仍为 1，不宣称多参考已完成。
  },
  videos: {
    models: [
      { id: 'wan2.6-i2v-flash', name: '万相 wan2.6-i2v-flash（图生视频）', inputKinds: ['image'], referenceCount: 1, referenceRoles: ['first_frame'] },
    ],
    resolutions: ['720P'],
    ratios: ['16:9'],
    durations: [2, 5],
    costEstimateAvailable: false,
    // 说明：仅实测 720P 图生视频；480P、文生视频、多图/视频参考未实测定格。
  },
};

export const STYLES = [
  { id: 'period_realistic', name: '古装真人', description: '写实古装人物，保留人物身份与服装等明确约束。' },
  { id: 'modern_realistic', name: '现代真人', description: '写实现代人物，保留人物身份与服装等明确约束。' },
  { id: 'chinese_2d', name: '中式二维', description: '中式二维画风人物，画面表现优先遵循当前风格选择。' },
  { id: 'game_cg', name: '游戏CG', description: '游戏CG质感人物，画面表现优先遵循当前风格选择。' },
];
