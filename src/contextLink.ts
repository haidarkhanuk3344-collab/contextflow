import type { VideoEdge, VideoNode } from './types.ts';

export const TEMPLATE_VERSION = "context-reference-v2";
export function contextTemplate(predecessorName: string, predecessorPrompt: string, currentName: string, currentPrompt: string, image = false) {
  return `${image ? "本次只生成一张当前镜头的图片，不要生成分镜拼图或前后对比图。" : "本次只生成当前镜头任务描述的视频。"}
前置镜头上下文仅用于理解叙事背景、人物指代和场景关系，不属于本次需要重演的内容。
当前镜头明确描述变化时，以当前镜头要求为准。

【前置镜头上下文（来自节点 ${predecessorName}）】
${predecessorPrompt}

【当前镜头任务（节点 ${currentName}）】
${currentPrompt}`;
}
export const REQUEST_LIMIT = 8000;
export const codePointLength = (text: string) => Array.from(text).length;

export function connectionError(source: string, target: string, nodes: VideoNode[], edges: VideoEdge[]): string | null {
  if (!nodes.some(n => n.id === source) || !nodes.some(n => n.id === target)) return '节点已不存在，请重新连接。';
  if (source === target) return '不能连接节点自身。';
  if (edges.some(e => e.source === source && e.target === target)) return '这两个节点之间已有同方向连线，不能重复连接。';
  if (edges.some(e => e.target === target)) return '该节点已有前驱，请先删除现有入线，再连接新的前驱。';
  const visited = new Set<string>();
  const pending = [target];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === source) return '这条连线会形成循环，无法连接。';
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...edges.filter(e => e.source === id).map(e => e.target));
  }
  return null;
}

// Shared by the live preview and the future submit path. Never rewrite raw text.
export function buildRequest(node: VideoNode, nodes: VideoNode[], edges: VideoEdge[]) {
  const incoming = edges.find(e => e.target === node.id);
  const predecessor = nodes.find(n => n.id === incoming?.source);
  const inherited = node.data.inheritEnabled !== false ? predecessor : undefined;
  const finalText = inherited
    ? contextTemplate(inherited.data.name, inherited.data.originalPrompt, node.data.name, node.data.originalPrompt, (node.data.kind || node.type) === 'image')
    : node.data.originalPrompt;
  const length = codePointLength(finalText);
  const issues: string[] = [];
  if (!node.data.originalPrompt.trim()) issues.push(`当前节点「${node.data.name || '未命名镜头'}」的原始提示词为空，请填写后再生成。`);
  if (inherited && !inherited.data.originalPrompt.trim()) issues.push(`前驱节点「${inherited.data.name || '未命名镜头'}」的原始提示词为空，请填写或关闭上下文继承。`);
  if (length > REQUEST_LIMIT) issues.push(`最终请求为 ${length} 字符，上限 ${REQUEST_LIMIT}，超出 ${length - REQUEST_LIMIT} 字符。`);
  return { predecessor, inherited, finalText, length, issues, valid: issues.length === 0 };
}
