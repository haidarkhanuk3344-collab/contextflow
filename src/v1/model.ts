import type { Edge, Node, Viewport } from '@xyflow/react';
export type Kind = 'image' | 'video';
export type Reference = { assetVersionId: string; role: 'reference' | 'first_frame' | 'last_frame' };
export type Context = { enabled: boolean; sourceNodeId: string | null; sourceVersionId: string | null };
export type NodeData = {
  name: string; kind: Kind; userInput: string; modelId: string;
  parameters: { size?: string; ratio?: string; resolution?: string; duration?: number; audio?: boolean };
  style: { presetId: string | null; customDescription: string | null };
  mediaReferences: Reference[]; context: Context; adoptedVersionId: string | null;
};
export type StudioNode = Node<NodeData, 'media'>;
export type Project = { id: string; name: string; revision: number; nodes: StudioNode[]; referenceEdges: Edge[]; viewport: Viewport; updatedAt: string };
export type Summary = Pick<Project, 'id' | 'name' | 'revision' | 'updatedAt'>;
export type Asset = { id: string; name: string; kind: string; categoryId?: string | null; projectId?: string | null; filename?: string | null; size?: number; mime?: string; nodeId?: string; url?: string; contentUrl?: string; createdAt: string };
export type Task = { id: string; requestId?: string; nodeId: string; status: string; phase?: string; error?: string | { message?: string }; allowedActions?: string[]; resultUrl?: string; assetVersionId?: string; result?: { url?: string; assetVersionId?: string }; createdAt: string; frozenInput?: { kind: Kind } };
export type Model = { id: string; name: string; inputKinds: string[]; referenceCount: number; referenceRoles?: string[] };
export type Capabilities = {
  images: { models: Model[]; sizes: string[] };
  videos: { models: Model[]; resolutions: string[]; ratios: string[]; durations: number[] };
  // Explicit optional readiness from backend. Static model declarations are not readiness.
  runtime?: { imageGeneration?: boolean; videoGeneration?: boolean; assetUpload?: boolean; context?: boolean };
};
export type Style = { id: string; name: string; description?: string };
export const blankData = (kind: Kind, name: string): NodeData => ({ name, kind, userInput: '', modelId: '', parameters: {}, style: { presetId: null, customDescription: null }, mediaReferences: [], context: { enabled: false, sourceNodeId: null, sourceVersionId: null }, adoptedVersionId: null });
const demoMediaUrls = new Map<string, string>();
export function mediaUrl(value?: string): string | undefined {
  if (!value) return undefined;
  if (import.meta.env?.VITE_DEMO === 'true') {
    if (value.startsWith('blob:') && [...demoMediaUrls.values()].includes(value)) return value;
    if (/^data:(image\/(png|jpeg|webp)|video\/(mp4|webm));base64,[A-Za-z0-9+/=]+$/.test(value)) {
      if (!demoMediaUrls.has(value)) {
        const [header, encoded] = value.split(',');
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        demoMediaUrls.set(value, URL.createObjectURL(new Blob([bytes], { type: header.slice(5, -7) })));
      }
      return demoMediaUrls.get(value);
    }
  }
  if (value.startsWith('/api/v1/assets/') && !value.includes('\\')) return value;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; }
}
export function normalizeAsset(asset: Asset): Asset {
  const contentUrl = mediaUrl(asset.contentUrl || asset.url) || (asset.filename && (asset.size || 0) > 0 ? `/api/v1/assets/${encodeURIComponent(asset.id)}/content` : undefined);
  return { ...asset, contentUrl };
}
export function contextSubmissionIssue(project: Project, node: StudioNode): string | null {
  if (!node.data.context.enabled) return null;
  const source = project.nodes.find(n => n.id === node.data.context.sourceNodeId);
  if (!source || source.data.kind !== node.data.kind || wouldCycle(project.nodes, node.id, source.id)) return '请选择有效的同类型承接来源';
  return null;
}
export function taskResult(task: Task) { return mediaUrl(task.result?.url || task.resultUrl); }
export function taskLabel(task: Task): string {
  if (task.status === 'succeeded') return taskResult(task) ? '已生成' : '结果不可用';
  return ({ preparing: '准备中', queued: '排队中', running: '生成中', awaiting_action: '待处理', failed: '生成失败', uncertain: '待确认', cancelled: '已取消' } as Record<string, string>)[task.status] || '待确认';
}
export function wouldCycle(nodes: StudioNode[], target: string, source: string): boolean {
  const seen = new Set([target]); let current: string | null = source;
  while (current) { if (seen.has(current)) return true; seen.add(current); const n = nodes.find(item => item.id === current); current = n?.data.context.enabled ? n.data.context.sourceNodeId : null; }
  return false;
}
export function generationInput(project: Project, node: StudioNode, requestId: string) {
  if (!node.data.userInput.trim()) throw new Error('请输入创作描述');
  const source = project.nodes.find(n => n.id === node.data.context.sourceNodeId);
  if (node.data.context.enabled) {
    if (!source || source.data.kind !== node.data.kind || wouldCycle(project.nodes, node.id, source.id)) throw new Error('请选择有效的同类型承接来源');
  }
  return { requestId, projectId: project.id, projectRevision: project.revision, nodeId: node.id, kind: node.data.kind, text: node.data.userInput, model: node.data.modelId, size: node.data.parameters.size, parameters: node.data.parameters, style: node.data.style, mediaReferences: node.data.mediaReferences, context: node.data.context, predecessorKind: source?.data.kind };
}
export function decodeProject(raw: Project): Project {
  if (!raw?.id || !Array.isArray(raw.nodes) || !Array.isArray(raw.referenceEdges) || typeof raw.revision !== 'number') throw new Error('项目数据不可用');
  return { ...raw, nodes: raw.nodes.map((n, i) => {
    const item = n as StudioNode & Partial<NodeData>;
    const d = item.data || item;
    const kind = d.kind === 'video' ? 'video' : 'image';
    return { ...n, type: 'media', position: n.position || { x: i * 420, y: 0 }, data: { ...blankData(kind, kind === 'image' ? '图片' : '视频'), ...d } };
  }) };
}

export type Category = { id: string; name: string; createdAt: string };
export function referenceIssue(model: Model | undefined, refs: Reference[], assets: Asset[]): string | null {
  if (!model) return '请选择模型';
  if (refs.length > model.referenceCount) return `当前模型最多支持 ${model.referenceCount} 个参考素材`;
  for (const ref of refs) {
    const asset = assets.find(a => a.id === ref.assetVersionId);
    const kind = asset?.mime?.startsWith('image/') ? 'image' : asset?.mime?.startsWith('video/') ? 'video' : '';
    if (!asset || !mediaUrl(asset.contentUrl || asset.url)) return '参考素材不可用';
    if (!model.inputKinds.includes(kind) || !(model.referenceRoles || ['reference']).includes(ref.role)) return '当前模型不支持所选参考素材或用途';
  }
  return null;
}

export function videoParameters(data: NodeData, caps: Capabilities): NodeData['parameters'] {
  return {
    resolution: data.parameters.resolution || caps.videos.resolutions[0],
    duration: data.parameters.duration ?? (caps.videos.durations.includes(5) ? 5 : caps.videos.durations[0]),
    audio: false,
  };
}
export function videoSubmissionIssue(data: NodeData, caps: Capabilities, assets: Asset[]): string | null {
  if (data.kind !== 'video') return null;
  const model = caps.videos.models.find(m => m.id === data.modelId);
  const issue = referenceIssue(model, data.mediaReferences, assets);
  if (issue) return issue;
  if (!data.mediaReferences.some(r => r.role === 'first_frame')) return '请选择首帧图片';
  const params = videoParameters(data, caps);
  if (!caps.videos.resolutions.includes(params.resolution || '')) return '请重新选择视频分辨率';
  if (!caps.videos.durations.includes(params.duration || 0)) return '请重新选择视频时长';
  return null;
}
