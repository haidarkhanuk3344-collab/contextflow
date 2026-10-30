import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Search, Trash2, Upload, X, Check } from 'lucide-react';
import { api } from './api';
import { mediaUrl } from './model';
import type { Asset, Category, Capabilities, Reference, StudioNode } from './model';
type Props = { assets: Asset[]; projectId: string; node?: StudioNode; caps: Capabilities | null; loadState: 'loading' | 'ready' | 'error'; onClose: () => void; onRefresh: () => Promise<void>; onUse: (asset: Asset, role: Reference['role']) => void; onAdd: (asset: Asset) => void };
export function Library({ assets, projectId, node, caps, loadState, onClose, onRefresh, onUse, onAdd }: Props) {
  const [tab, setTab] = useState<'upload' | 'generated'>('upload');
  const [query, setQuery] = useState(''); const [category, setCategory] = useState('');
  const [categories, setCategories] = useState<Category[]>([]); const [name, setName] = useState('');
  const [creating, setCreating] = useState(false); const [renaming, setRenaming] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [preview, setPreview] = useState<Asset | null>(null); const input = useRef<HTMLInputElement>(null); const dialog = useRef<HTMLDialogElement>(null);
  const loadCategories = () => api.categories().then(setCategories);
  useEffect(() => { void loadCategories().catch(e => setError(e.message)); }, []);
  useEffect(() => { if (preview) dialog.current?.showModal(); else dialog.current?.close(); }, [preview]);
  const model = node && (node.data.kind === 'image' ? caps?.images.models : caps?.videos.models)?.find(m => m.id === node.data.modelId);
  const roles = (model?.referenceRoles || ['reference']) as Reference['role'][];
  const labels = { reference: '用作参考', first_frame: '用作首帧', last_frame: '用作尾帧' };
  const visible = assets.filter(a => tab === 'upload' ? a.kind === 'upload' : a.kind === 'generated' && a.projectId === projectId).filter(a => tab !== 'upload' || !category || (category === 'uncategorized' ? !a.categoryId : a.categoryId === category)).filter(a => a.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } };
  const upload = async (file?: File) => {
    if (!file) return;
    await run(async () => {
      if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(file.type) || file.size > 18_000_000) throw new Error('请选择 18MB 以内的 PNG、JPG、WebP 或 MP4 文件');
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file); });
      await api.upload({ projectId, name: file.name, kind: 'upload', mime: file.type, ext: file.name.split('.').pop(), dataUrl, categoryId: category && category !== 'uncategorized' ? category : null });
      setTab('upload'); setQuery(''); await onRefresh();
    });
    if (input.current) input.current.value = '';
  };
  return <aside className="v1-sidepanel v1-library" aria-label="素材库">
    <header><h2>素材库</h2><button aria-label="关闭面板" onClick={onClose}><X size={18}/></button></header>
    <div className="v1-library-tabs"><button aria-pressed={tab === 'upload'} onClick={() => setTab('upload')}>我的上传</button><button aria-pressed={tab === 'generated'} onClick={() => setTab('generated')}>项目结果</button></div>
    <label className="v1-library-search"><Search size={16}/><input aria-label="搜索素材" placeholder="搜索素材" value={query} onChange={e => setQuery(e.target.value)}/></label>
    {tab === 'upload' && <><div className="v1-library-categories"><select aria-label="素材分类" value={category} onChange={e => { setCategory(e.target.value); setRenaming(null); setCreating(false); }}><option value="">全部分类</option><option value="uncategorized">未分类</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><button aria-label="新建分类" title="新建分类" onClick={() => { setRenaming(null); setName(''); setCreating(!creating); }}><Plus size={16}/></button>{category && category !== 'uncategorized' && <button aria-label="重命名分类" title="重命名分类" disabled={busy} onClick={() => { setRenaming(category); setName(categories.find(c => c.id === category)?.name || ''); setCreating(true); }}><Pencil size={16}/></button>}{category && category !== 'uncategorized' && <button aria-label="删除分类" title="删除分类" disabled={busy} onClick={() => { if (window.confirm('删除此分类？素材将移至未分类，原文件保留。')) void run(async () => { await api.deleteCategory(category); setCategory(''); setCreating(false); setRenaming(null); await Promise.all([loadCategories(), onRefresh()]); }); }}><Trash2 size={16}/></button>}</div>
    {creating && <form className="v1-category-form" onSubmit={e => { e.preventDefault(); if (name.trim()) void run(async () => { const c = renaming ? await api.renameCategory(renaming, name.trim()) : await api.createCategory(name.trim()); await loadCategories(); setCategory(c.id); setCreating(false); setRenaming(null); setName(''); }); }}><input aria-label="分类名称" placeholder="分类名称" maxLength={50} value={name} onChange={e => setName(e.target.value)} autoFocus/><button disabled={busy || !name.trim()}>{renaming ? '保存' : '创建'}</button><button type="button" onClick={() => { setCreating(false); setRenaming(null); }}>取消</button></form>}
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,video/mp4" hidden onChange={e => void upload(e.target.files?.[0])}/><button className="v1-upload" disabled={busy || !caps?.runtime?.assetUpload} onClick={() => input.current?.click()}><Upload size={16}/>{busy ? '处理中' : '上传图片'}</button></>}
    {error && <div role="alert" className="v1-error">{error}<button aria-label="关闭错误" onClick={() => setError('')}><X size={14}/></button></div>}
    {loadState === 'loading' ? <div className="v1-empty">加载中</div> : loadState === 'error' ? <div className="v1-empty">加载失败<button onClick={() => void run(onRefresh)}>重试</button></div> : !visible.length ? <div className="v1-empty">{query ? '没有匹配的素材' : '暂无素材'}</div> : <div className="v1-library-grid">{visible.map(a => { const url = mediaUrl(a.contentUrl || a.url); const selected = node?.data.mediaReferences.some(r => r.assetVersionId === a.id); return <article className="v1-library-item" key={a.id}>
      <button className="v1-library-preview" aria-label={`预览 ${a.name}`} disabled={!url} onClick={() => setPreview(a)}>{a.mime?.startsWith('video/') ? <video src={url} preload="metadata"/> : <img src={url} alt={a.name} loading="lazy"/>}{selected && <span><Check size={14}/></span>}</button>
      <strong title={a.name}>{a.name}</strong>{a.kind === 'upload' && <select aria-label={`分类 ${a.name}`} value={a.categoryId || ''} disabled={busy} onChange={e => { const next = e.target.value || null; void run(async () => { await api.moveAsset(a.id, next); await onRefresh(); }); }}><option value="">未分类</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}<div className="v1-library-actions"><button disabled={!url || busy} onClick={() => onAdd(a)}>添加到画布</button>{node && roles.map(role => <button key={role} disabled={!url || busy || !model} onClick={() => { try { onUse(a, role); setError(''); } catch(e) { setError((e as Error).message); } }}>{labels[role]}</button>)}</div>
    </article>; })}</div>}
    <dialog ref={dialog} className="v1-preview-dialog" onCancel={() => setPreview(null)} onClose={() => setPreview(null)}><header><strong>{preview?.name}</strong><button aria-label="关闭预览" onClick={() => setPreview(null)}><X size={20}/></button></header>{preview && (preview.mime?.startsWith('video/') ? <video src={mediaUrl(preview.contentUrl || preview.url)} controls/> : <img src={mediaUrl(preview.contentUrl || preview.url)} alt={preview.name}/>)}</dialog>
  </aside>;
}
