import { createContext, memo, useContext } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { ImageIcon, Link2, Video } from 'lucide-react';
import type { StudioNode } from './model';
export const MediaContext = createContext<Record<string, { url?: string; status?: string; source?: string }>>({});
export const MediaNode = memo(function MediaNode({ id, data, selected }: NodeProps<StudioNode>) {
  const meta = useContext(MediaContext)[id] || {};
  return <article className={`video-node bento-node v1-media-node${selected ? ' is-selected' : ''}`} aria-label={`${data.kind === 'image' ? '图片' : '视频'}节点 ${data.name}`}>
    <Handle id="in" type="target" position={Position.Left} aria-label="素材输入" />
    <header className="bento-heading">{data.kind === 'image' ? <ImageIcon size={16}/> : <Video size={16}/>}<strong>{data.name}</strong>{meta.status && <span>{meta.status}</span>}</header>
    <div className="bento-preview">{meta.url ? data.kind === 'image' ? <a className="nodrag nopan" href={meta.url} target="_blank" rel="noreferrer" aria-label="查看图片"><img src={meta.url} alt={data.name} onError={e => { e.currentTarget.alt = '图片不可用'; }}/></a> : <video className="nodrag nopan" src={meta.url} controls preload="metadata" aria-label={data.name}/> : <div className="bento-empty">{data.kind === 'image' ? <ImageIcon size={36} strokeWidth={1.2}/> : <Video size={36} strokeWidth={1.2}/>}</div>}</div>
    {data.context.enabled && <div className="node-context-line"><Link2 size={14}/><span>{meta.source || '请选择承接来源'}</span></div>}
    <Handle id="out" type="source" position={Position.Right} aria-label="素材输出" />
  </article>;
});
