import { useCallback, useEffect, useRef, useState } from 'react';
import { addEdge, applyEdgeChanges, applyNodeChanges, Background, BackgroundVariant, MiniMap, ReactFlow, useReactFlow } from '@xyflow/react';
import type { Connection, NodeChange } from '@xyflow/react';
import { ArrowLeft, Check, Download, Film, Focus, FolderOpen, Hand, History, ImagePlus, Map, Magnet, Minus, MousePointer2, Plus, X } from 'lucide-react';
import { Logo } from '../components/Logo';
import { api, ApiError } from './api';
import { blankData, videoParameters, videoSubmissionIssue, referenceIssue, contextSubmissionIssue, generationInput, mediaUrl, taskLabel, taskResult } from './model';
import type { Asset, Capabilities, Kind, NodeData, Project, StudioNode, Style, Task } from './model';
import { useProject } from './useProject';
import { MediaContext, MediaNode } from './MediaNode';
import { Editor } from './Editor';
import { Library } from './Library';
import '@xyflow/react/dist/style.css';
const nodeTypes = { media: MediaNode };
const activeTask = (t: Task) => ['preparing', 'queued', 'running', 'awaiting_action', 'uncertain'].includes(t.status);
function downloadDraft(p: Project) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `${p.name || '画布'}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Studio({ initial, onBack }: { initial: Project; onBack: () => void }) {
  const { project, change, save, status, error: saveError, reload, conflict } = useProject(initial);
  const [caps, setCaps] = useState<Capabilities | null>(null); const [styles, setStyles] = useState<Style[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]); const [tasks, setTasks] = useState<Task[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [notice, setNotice] = useState(''); const [panel, setPanel] = useState<'assets' | 'tasks' | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null); const [map, setMap] = useState(false); const [snap, setSnap] = useState(false);
  const [selected, setSelected] = useState<string | null>(null); const [pan, setPan] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState<string[]>([]); const locks = useRef(new Set<string>());
  const [deleting, setDeleting] = useState(false); const confirmRef = useRef<HTMLDialogElement>(null);
  const [taskError, setTaskError] = useState('');
  const { screenToFlowPosition, fitView, zoomIn, zoomOut, setViewport } = useReactFlow<StudioNode>();
  const node = project.nodes.find(n => n.id === selected);
  const refresh = useCallback(async () => { try { const [cap, presets, av, ts] = await Promise.all([api.capabilities(), api.styles(), api.assets(initial.id), api.tasks(initial.id)]); setCaps(cap); setStyles(presets); setAssets(av); setTasks(ts); setLoadState('ready'); setNotice(''); } catch (e) { setNotice((e as Error).message); setLoadState('error'); } }, [initial.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  // Only poll unfinished tasks; visibility and errors back off without overlapping requests.
  useEffect(() => {
    if (!tasks.some(activeTask)) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = document.hidden ? 12000 : 2500;
      if (!document.hidden) { try { const next = await api.tasks(initial.id); if (!disposed) { setTasks(next); setTaskError(''); } } catch (e) { delay = 10000; if (!disposed) setTaskError((e as Error).message); } }
      if (!disposed) timer = setTimeout(poll, delay);
    }; timer = setTimeout(poll, 2500); return () => { disposed = true; clearTimeout(timer); };
  }, [initial.id, tasks]);
  useEffect(() => { if (deleting) confirmRef.current?.showModal(); else confirmRef.current?.close(); }, [deleting]);
  const update = (id: string, patch: Partial<NodeData>) => change(p => ({ ...p, nodes: p.nodes.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n) }));
  const add = useCallback((kind: Kind, client?: { x: number; y: number }) => {
    const id = crypto.randomUUID(); const last = project.nodes.at(-1); const position = client ? screenToFlowPosition(client) : last ? { x: last.position.x + 420, y: last.position.y } : screenToFlowPosition({ x: window.innerWidth / 2 - 180, y: Math.max(160, window.innerHeight / 2 - 220) });
    const data = blankData(kind, `${kind === 'image' ? '图片' : '视频'} ${project.nodes.length + 1}`);
    data.modelId = (kind === 'image' ? caps?.images.models[0] : caps?.videos.models[0])?.id || '';
    data.parameters = kind === 'image' ? { size: caps?.images.sizes[0] } : (caps ? videoParameters(data, caps) : { audio: false });
    change(p => ({ ...p, nodes: [...p.nodes.map(n => ({ ...n, selected: false })), { id, type: 'media', position, selected: true, data }] })); setSelected(id); setMenu(null);
  }, [caps, change, project.nodes, screenToFlowPosition]);
  useEffect(() => { const key = `jingliu:add:${initial.id}`; const kind = sessionStorage.getItem(key); if (caps && (kind === 'image' || kind === 'video')) { sessionStorage.removeItem(key); add(kind); } }, [caps, initial.id, add]);
  const connect = (c: Connection) => {
    if (c.source === c.target || project.referenceEdges.some(e => e.source === c.source && e.target === c.target)) return;
    const source = project.nodes.find(n => n.id === c.source); const target = project.nodes.find(n => n.id === c.target);
    if (source?.data.adoptedVersionId && target && !target.data.mediaReferences.some(r => r.assetVersionId === source.data.adoptedVersionId)) {
      const model = (target.data.kind === 'image' ? caps?.images.models : caps?.videos.models)?.find(m => m.id === target.data.modelId);
      const role = (model?.referenceRoles?.[0] || 'reference') as 'reference' | 'first_frame' | 'last_frame';
      const refs = [...target.data.mediaReferences, { assetVersionId: source.data.adoptedVersionId, role }];
      const issue = referenceIssue(model, refs, assets); if (issue) { setNotice(issue); return; }
      update(target.id, { mediaReferences: refs });
    }
    change(p => ({ ...p, referenceEdges: addEdge({ ...c, id: crypto.randomUUID() }, p.referenceEdges) }));
  };
  const select = (n: StudioNode) => { setSelected(n.id); setSelectedEdge(null); setMenu(null); };
  useEffect(() => {
    if (!selected) return;
    const focus = () => { const n = project.nodes.find(v => v.id === selected); if (!n) return; const zoom = Math.min(1, (window.innerWidth - 40) / 360, (window.innerHeight * .42 - 90) / 264); void setViewport({ x: window.innerWidth / 2 - (n.position.x + 180) * zoom, y: 100 - n.position.y * zoom, zoom: Math.max(.3, zoom) }); };
    focus(); window.addEventListener('resize', focus); return () => window.removeEventListener('resize', focus);
  // Reframe only on selection or resize, leaving manual pan/zoom untouched.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, setViewport]);
  const remove = () => { if (!node || tasks.some(t => t.nodeId === node.id && activeTask(t))) return; change(p => ({ ...p, nodes: p.nodes.filter(n => n.id !== node.id), referenceEdges: p.referenceEdges.filter(e => e.source !== node.id && e.target !== node.id) })); setSelected(null); setDeleting(false); };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenu(null); setPanel(null); return; }
      const target = event.target as HTMLElement;
      if (event.isComposing || target.closest('input,textarea,select,button,dialog,[contenteditable=true]')) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (selectedEdge) { event.preventDefault(); change(p => ({ ...p, referenceEdges: p.referenceEdges.filter(e => e.id !== selectedEdge) })); setSelectedEdge(null); }
      else if (node && !tasks.some(t => t.nodeId === node.id && activeTask(t))) { event.preventDefault(); setDeleting(true); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [node, tasks, selectedEdge, change]);
  const copy = () => { if (!node) return; const id = crypto.randomUUID(); change(p => ({ ...p, nodes: [...p.nodes.map(n => ({ ...n, selected: false })), { ...structuredClone(node), id, position: { x: node.position.x + 400, y: node.position.y }, selected: true, data: { ...structuredClone(node.data), name: `${node.data.name} 副本`, adoptedVersionId: null } }] })); setSelected(id); };
  const submit = async () => {
    if (!node || locks.current.has(node.id) || !caps) return;
    if (!(node.data.kind === 'image' ? caps.runtime?.imageGeneration : caps.runtime?.videoGeneration)) { setNotice('生成暂不可用'); return; }
    if (node.data.context.enabled && !caps.runtime?.context) { setNotice('上下文承接暂不可用'); return; }
    const model = (node.data.kind === 'image' ? caps.images.models : caps.videos.models).find(m => m.id === node.data.modelId);
    if (!model) { setNotice('请选择模型'); return; }
    const referenceError = referenceIssue(model, node.data.mediaReferences, assets);
    if (referenceError) { setNotice(referenceError); return; }
    const videoIssue = videoSubmissionIssue(node.data, caps, assets);
    if (videoIssue) { setNotice(videoIssue); return; }
    const contextIssue = contextSubmissionIssue(project, node);
    if (contextIssue) { setNotice(contextIssue); return; }
    locks.current.add(node.id); setBusy(v => [...v, node.id]); setNotice('');
    const key = `jingliu:submission:${project.id}:${node.id}`;
    try {
      const saved = await save(); const current = saved.nodes.find(n => n.id === node.id)!;
      const pending = sessionStorage.getItem(key); const fresh = generationInput(saved, current.data.kind === 'video' ? { ...current, data: { ...current.data, parameters: videoParameters(current.data, caps) } } : current, crypto.randomUUID());
      const body = pending ? JSON.parse(pending) : fresh;
      if (pending) {
        const known = (await api.tasks(project.id)).find(t => t.requestId === body.requestId);
        if (known) { setTasks(ts => [known, ...ts.filter(t => t.id !== known.id)]); sessionStorage.removeItem(key); setPanel('tasks'); return; }
        const normalize = (v: typeof fresh) => ({ ...v, requestId: null, projectRevision: null });
        if (JSON.stringify(normalize(body)) !== JSON.stringify(normalize(fresh))) throw new Error('上次提交尚未确认，请恢复原输入后重试');
      }
      sessionStorage.setItem(key, JSON.stringify(body));
      const task = await api.generate(body); setTasks(ts => [task, ...ts.filter(t => t.id !== task.id)]); sessionStorage.removeItem(key); setPanel('tasks');
    } catch (e) { if (e instanceof ApiError && [400, 401, 403, 404, 422, 429].includes(e.status)) sessionStorage.removeItem(key); setNotice((e as Error).message); } finally { locks.current.delete(node.id); setBusy(v => v.filter(id => id !== node.id)); }
  };
  const downloadResult = async (task: Task) => {
    const url = taskResult(task); if (!url || locks.current.has(`download:${task.id}`)) return;
    const key = `download:${task.id}`; locks.current.add(key); setBusy(v => [...v, key]);
    try {
      const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error('下载失败，请重试');
      const blob = await response.blob();
      if (!blob.size || !/^(image|video)\//.test(blob.type)) throw new Error('结果文件不可用');
      const href = URL.createObjectURL(blob); const a = document.createElement('a');
      const ext = blob.type.startsWith('video/') ? 'mp4' : blob.type.includes('jpeg') ? 'jpg' : blob.type.split('/')[1];
      a.href = href; a.download = `镜流-${task.id}.${ext}`; a.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e) { setNotice((e as Error).message); }
    finally { locks.current.delete(key); setBusy(v => v.filter(id => id !== key)); }
  };
  const act = async (task: Task, action: string) => {
    if (locks.current.has(task.id)) return; locks.current.add(task.id); setBusy(v => [...v, task.id]);
    try { const next = await api.action(task.id, action, crypto.randomUUID()); setTasks(ts => ts.map(t => t.id === next.id ? next : t)); }
    catch (e) { setNotice((e as Error).message); } finally { locks.current.delete(task.id); setBusy(v => v.filter(id => id !== task.id)); }
  };
  useEffect(() => { if (tasks.some(t => t.status === 'succeeded' && taskResult(t))) void api.assets(initial.id).then(setAssets).catch(() => {}); }, [tasks, initial.id]);
  const meta = Object.fromEntries(project.nodes.map(n => {
    const adopted = assets.find(a => a.id === n.data.adoptedVersionId);
    const selectedTask = tasks.find(t => (t.assetVersionId || t.result?.assetVersionId) === n.data.adoptedVersionId && taskResult(t));
    return [n.id, { url: mediaUrl(adopted?.url || adopted?.contentUrl) || (selectedTask ? taskResult(selectedTask) : taskResult(tasks.find(t => t.nodeId === n.id && t.status === 'succeeded' && taskResult(t)) || { id: '', nodeId: n.id, status: '', createdAt: '' })), status: tasks.find(t => t.nodeId === n.id) ? taskLabel(tasks.find(t => t.nodeId === n.id)!) : undefined, source: project.nodes.find(s => s.id === n.data.context.sourceNodeId)?.data.name }];
  }));
  const filteredTasks = selected ? tasks.filter(t => t.nodeId === selected) : tasks;
  const changeNodes = (changes: NodeChange<StudioNode>[]) => change(p => ({ ...p, nodes: applyNodeChanges(changes, p.nodes) }));
  return <div className="workspace v1-studio"><header className="studio-topbar"><div className="project-island"><button className="icon-button" title="返回首页" aria-label="返回首页" onClick={() => void save().then(onBack).catch(() => {})}><ArrowLeft size={17}/></button><Logo compact/><span className="topbar-divider"/><input className="project-name-input" aria-label="项目名称" value={project.name} maxLength={100} onChange={e => change(p => ({ ...p, name: e.target.value }))}/><span className="save-indicator" role="status"><Check size={13}/>{status}</span></div><div className="action-island"><button className="studio-action" onClick={() => setPanel(panel === 'assets' ? null : 'assets')}><FolderOpen size={16}/>素材库</button><button className="studio-action" onClick={() => setPanel(panel === 'tasks' ? null : 'tasks')}><History size={16}/>历史</button><button className="studio-action" onClick={() => downloadDraft(project)}><Download size={16}/>导出画布</button></div></header>
    <main className="workbench"><MediaContext.Provider value={meta}><ReactFlow<StudioNode> nodes={project.nodes} edges={project.referenceEdges} nodeTypes={nodeTypes} onNodesChange={changeNodes} onEdgesChange={changes => change(p => ({ ...p, referenceEdges: applyEdgeChanges(changes, p.referenceEdges) }))} onConnect={connect} snapToGrid={snap} snapGrid={[24,24]} onEdgeClick={(_, e) => { setSelectedEdge(e.id); setSelected(null); }} onNodeClick={(_, n) => select(n)} onPaneClick={() => { setSelected(null); setSelectedEdge(null); setMenu(null); }} onPaneContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }} onDoubleClick={e => { if ((e.target as HTMLElement).classList.contains('react-flow__pane')) setMenu({ x: e.clientX, y: e.clientY }); }} defaultViewport={project.viewport} onMoveEnd={(_, viewport) => change(p => ({ ...p, viewport }))} colorMode="dark" minZoom={.2} maxZoom={2} zoomOnDoubleClick={false} selectionOnDrag={!pan} panOnDrag={pan ? true : [1, 2]} deleteKeyCode={null}><Background variant={BackgroundVariant.Dots} color="#383a3a" gap={20}/>{map && <MiniMap pannable zoomable nodeColor="#667a73" maskColor="#141616b0"/>}</ReactFlow></MediaContext.Provider>
    {!project.nodes.length && <div className="v1-canvas-empty"><button onClick={() => add('image')}><ImagePlus size={22}/>图片生成</button><button onClick={() => add('video')}><Film size={22}/>视频生成</button></div>}
    {menu && <div className="node-menu v1-add-menu" style={{ left: Math.min(menu.x, window.innerWidth - 225), top: Math.min(menu.y, window.innerHeight - 150) }}><header>添加节点<button aria-label="关闭菜单" onClick={() => setMenu(null)}><X size={16}/></button></header><button onClick={() => add('image', menu)}><ImagePlus size={18}/>图片</button><button onClick={() => add('video', menu)}><Film size={18}/>视频</button></div>}
    <div className="v1-zoom"><button aria-label="缩小" title="缩小" onClick={() => void zoomOut()}><Minus size={16}/></button><span>{Math.round(project.viewport.zoom * 100)}%</span><button aria-label="放大" title="放大" onClick={() => void zoomIn()}><Plus size={16}/></button><button aria-label="适应画布" title="适应画布" onClick={() => void fitView({ padding: .3, maxZoom: 1 })}><Focus size={17}/></button><button title="小地图" aria-label="小地图" aria-pressed={map} onClick={() => setMap(!map)}><Map size={16}/></button><button title="网格吸附" aria-label="网格吸附" aria-pressed={snap} onClick={() => setSnap(!snap)}><Magnet size={16}/></button></div>{selectedEdge && <button className="v1-disconnect" onClick={() => { change(p => ({ ...p, referenceEdges: p.referenceEdges.filter(e => e.id !== selectedEdge) })); setSelectedEdge(null); }}>断开连线</button>}
    {!node && <nav className="studio-dock" aria-label="画布工具"><button className="dock-add" title="添加节点" aria-label="添加节点" onClick={() => setMenu({ x: window.innerWidth / 2 - 100, y: window.innerHeight - 230 })}><Plus size={23}/></button><button title={pan ? '切换框选' : '切换移动'} aria-label={pan ? '切换框选' : '切换移动'} onClick={() => setPan(!pan)}>{pan ? <Hand size={19}/> : <MousePointer2 size={19}/>}</button><i/><button title="添加图片" onClick={() => add('image')}><ImagePlus size={19}/><span>图片</span></button><button title="添加视频" onClick={() => add('video')}><Film size={19}/><span>视频</span></button></nav>}
    {node && caps && <Editor node={node} project={project} capabilities={caps} styles={styles} assets={assets} busy={busy.includes(node.id) || tasks.some(t => t.nodeId === node.id && activeTask(t))} ready={!!(node.data.kind === 'image' ? caps.runtime?.imageGeneration : caps.runtime?.videoGeneration)} onUpdate={patch => update(node.id, patch)} onGenerate={() => void submit()} onClose={() => setSelected(null)} onCopy={copy} onDelete={() => setDeleting(true)} onAssets={() => setPanel('assets')}/>}
    {(notice || saveError) && <div className="v1-notice" role="alert"><span>{saveError || notice}</span>{saveError && <><button onClick={() => downloadDraft(project)}>下载草稿</button><button onClick={() => { if (conflict) { if (window.confirm('重新加载将替换当前未保存的修改，是否继续？')) void reload().catch(e => setNotice(e.message)); } else void save().catch(() => {}); }}>{conflict ? '重新加载' : '重试保存'}</button></>}{!saveError && <button aria-label="关闭提示" onClick={() => setNotice('')}><X size={16}/></button>}</div>}
    {loadState === 'error' && <button className="v1-reconnect" onClick={() => void refresh()}>重新连接</button>}
    {panel === 'assets' && <Library loadState={loadState} assets={assets} projectId={project.id} node={node} caps={caps} onClose={() => setPanel(null)} onRefresh={async () => { const next = await api.assets(project.id); setAssets(next); setLoadState('ready'); }} onUse={(asset, role) => {
      if (!node || !caps) return;
      const refs = [...node.data.mediaReferences.filter(r => r.assetVersionId !== asset.id), { assetVersionId: asset.id, role }];
      const model = (node.data.kind === 'image' ? caps.images.models : caps.videos.models).find(m => m.id === node.data.modelId);
      const issue = referenceIssue(model, refs, assets); if (issue) throw new Error(issue);
      update(node.id, { mediaReferences: refs });
    }} onAdd={asset => {
      const kind: Kind = asset.mime?.startsWith('video/') ? 'video' : 'image'; const id = crypto.randomUUID();
      const data = { ...blankData(kind, asset.name), adoptedVersionId: asset.id, modelId: (kind === 'image' ? caps?.images.models[0] : caps?.videos.models[0])?.id || '' };
      change(p => ({ ...p, nodes: [...p.nodes, { id, type: 'media', position: screenToFlowPosition({ x: window.innerWidth / 2, y: 200 }), data }] })); setSelected(id); setPanel(null);
    }}/ >}
    {panel === 'tasks' && <aside className="v1-sidepanel" aria-label="生成历史"><header><h2>生成历史</h2><button aria-label="关闭面板" onClick={() => setPanel(null)}><X size={18}/></button></header>
    {selected && <button className="v1-all-tasks" onClick={() => setSelected(null)}>查看全部历史</button>}{taskError && <div role="alert" className="v1-error">{taskError}<button onClick={() => void refresh()}>重试</button></div>}
    {loadState === 'loading' ? <div className="v1-empty">加载中</div> : !filteredTasks.length ? <div className="v1-empty">暂无记录</div> : filteredTasks.map(t => <article className="v1-task" key={t.id}><header><strong>{project.nodes.find(n => n.id === t.nodeId)?.data.name || '已删除节点'}</strong><span>{taskLabel(t)}</span></header><time>{new Date(t.createdAt).toLocaleString('zh-CN')}</time>{t.error && <p role="alert">{typeof t.error === 'string' ? t.error : t.error.message}</p>}{taskResult(t) && <><a href={taskResult(t)} target="_blank" rel="noreferrer">查看结果</a><button disabled={busy.includes(`download:${t.id}`)} onClick={() => void downloadResult(t)}>{busy.includes(`download:${t.id}`) ? '下载中' : '下载'}</button>{(t.assetVersionId || t.result?.assetVersionId) && <button disabled={!project.nodes.some(n => n.id === t.nodeId) || project.nodes.find(n => n.id === t.nodeId)?.data.adoptedVersionId === (t.assetVersionId || t.result?.assetVersionId)} onClick={() => update(t.nodeId, { adoptedVersionId: t.assetVersionId || t.result?.assetVersionId || null })}>{project.nodes.find(n => n.id === t.nodeId)?.data.adoptedVersionId === (t.assetVersionId || t.result?.assetVersionId) ? '当前采用' : '采用此版本'}</button>}</>}{t.status === 'awaiting_action' && <div className="v1-task-actions">{(t.allowedActions || []).filter(a => ['retry_preparation', 'continue_text_only', 'cancel'].includes(a)).map(a => <button key={a} disabled={busy.includes(t.id)} onClick={() => void act(t, a)}>{({ retry_preparation: '重试', continue_text_only: '仅文字继续', cancel: '取消' } as Record<string, string>)[a]}</button>)}</div>}</article>)}
    </aside>}
    </main>
    <dialog ref={confirmRef} className="v1-confirm" onCancel={() => setDeleting(false)} onClose={() => setDeleting(false)}><h2>删除节点？</h2><div><button onClick={() => setDeleting(false)}>取消</button><button onClick={remove}>删除</button></div></dialog>
  </div>;
}
