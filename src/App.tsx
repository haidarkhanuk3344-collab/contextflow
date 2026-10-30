import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ArrowUpRight, FolderOpen, Home, ImagePlus, Layers, LogOut, Plus, Search, Video } from 'lucide-react';
import { Logo } from './components/Logo';
import { api, ApiError } from './v1/api';
import type { Project, Summary } from './v1/model';
import { Studio } from './v1/Studio';
import './App.css';
import './studio.css';
import './v1/ui.css';

export default function App() {
  const [user, setUser] = useState<{ id: string; name: string; role?: string } | null>(null);
  const [ready, setReady] = useState(false); const [error, setError] = useState('');
  const [projects, setProjects] = useState<Summary[]>([]); const [active, setActive] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false); const [tab, setTab] = useState('home'); const [search, setSearch] = useState('');
  const [setupToken] = useState(() => { const token = window.location.hash.match(/^#\/admin\/setup\/([a-f0-9]{64})$/)?.[1] || ''; if (token) history.replaceState(null, '', '#/admin/setup'); return token; });
  const [adminMode, setAdminMode] = useState(window.location.hash.startsWith('#/admin'));
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState('');
  const [newInvite, setNewInvite] = useState('');
  const [name, setName] = useState(''); const [invite, setInvite] = useState('');
  const load = async () => {
    setError(''); setReady(false);
    try { const me = await api.me(); setUser(me.user); setProjects(await api.projects());
      const id = window.location.hash.match(/^#\/projects\/([^/]+)$/)?.[1];
      if (id) setActive(await api.project(decodeURIComponent(id)));
    } catch (e) { if (!(e instanceof ApiError && e.status === 401)) setError((e as Error).message); }
    finally { setReady(true); }
  };
  useEffect(() => { if (setupToken || adminMode) setReady(true); else void load(); const expired = () => { setUser(null); setActive(null); setError('登录已过期'); }; window.addEventListener('jingliu:unauthorized', expired); return () => window.removeEventListener('jingliu:unauthorized', expired); }, []);
  const open = async (id: string) => { setBusy(true); setError(''); try { const p = await api.project(id); setActive(p); window.location.hash = `/projects/${p.id}`; } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const create = async (kind?: 'image' | 'video') => { if (busy) return; setBusy(true); setError(''); try { const p = await api.create(); setActive(p); window.location.hash = `/projects/${p.id}`; if (kind) sessionStorage.setItem(`jingliu:add:${p.id}`, kind); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const back = async () => { setActive(null); window.location.hash = '/'; try { setProjects(await api.projects()); } catch (e) { setError((e as Error).message); } };
  if (!ready) return <main className="v1-loading" role="status">加载中</main>;
  if (!user) return <main className="v1-login"><form onSubmit={async e => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); try { if (setupToken) { if (password !== confirmation) throw new Error('两次密码不一致'); await api.adminSetup(setupToken, password); window.location.hash = '/'; } else if (adminMode) { await api.adminLogin(password); window.location.hash = '/'; } else await api.login(invite.trim(), name.trim()); setInvite(''); setPassword(''); setConfirmation(''); await load(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}>
    <Logo /><h1>{setupToken ? '设置管理员密码' : adminMode ? '管理员登录' : '登录镜流'}</h1>
    {adminMode ? <><label>密码<input type="password" autoComplete={setupToken ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={setupToken ? 10 : undefined} maxLength={128} placeholder={setupToken ? '至少 10 位' : undefined}/></label>{setupToken && <label>确认密码<input type="password" autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} required minLength={10} maxLength={128}/></label>}</> : <><label>姓名<input autoComplete="name" value={name} onChange={e => setName(e.target.value)} required maxLength={100} /></label><label>邀请码<input autoComplete="off" type="password" value={invite} onChange={e => setInvite(e.target.value)} required maxLength={200} /></label></>}
    {error && <p className="v1-error" role="alert">{error}</p>}
    <button className="primary-button" disabled={busy}>{busy ? '处理中' : setupToken ? '设置并登录' : '登录'}</button>
    {!setupToken && <button type="button" className="text-button" onClick={() => { setAdminMode(!adminMode); setPassword(''); setError(''); }}>{adminMode ? '邀请码登录' : '管理员登录'}</button>}
  </form></main>;
  if (active) return <ReactFlowProvider key={active.id}><Studio initial={active} onBack={back} /></ReactFlowProvider>;
  const filtered = projects.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  return <div className="home-shell v1-home"><aside className="home-sidebar"><Logo /><nav aria-label="主导航">
    <button className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}><Home size={18} />首页</button>
    <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}><FolderOpen size={18} />项目</button>
    </nav><button className="v1-account" onClick={async () => { try { await api.logout(); setUser(null); setProjects([]); } catch (e) { setError((e as Error).message); } }} title="退出登录"><span>{user.name}</span><LogOut size={16} /></button></aside>
    <main className="home-main"><header className="home-header"><h1>{tab === 'home' ? '工作空间' : '项目'}</h1>{user.role !== 'admin' && <button className="text-button" onClick={() => { setAdminMode(true); setUser(null); setError(''); window.location.hash = '/admin'; }}>管理员入口</button>}{user.role === 'admin' && <button className="text-button" onClick={async () => { try { setNewInvite((await api.invite()).inviteToken); } catch (e) { setError((e as Error).message); } }}>生成邀请码</button>}<label className="home-search"><Search size={16}/><input aria-label="搜索项目" placeholder="搜索项目" value={search} onChange={e => setSearch(e.target.value)} /></label></header>
    <div className="home-content">{newInvite && <div className="v1-error" role="status"><span>邀请码：{newInvite}</span><button onClick={() => setNewInvite('')}>关闭</button></div>}{error && <div className="v1-error" role="alert">{error}<button onClick={() => void load()}>重试</button></div>}
      {tab === 'home' && <><button disabled={busy} className="v1-create" onClick={() => void create()}><Plus size={30}/><span>新建画布</span></button><div className="v1-shortcuts"><button disabled={busy} onClick={() => void create('image')}><ImagePlus size={22}/>图片生成</button><button disabled={busy} onClick={() => void create('video')}><Video size={22}/>视频生成</button></div></>}
      <section><div className="section-heading"><h2>{tab === 'home' ? '最近项目' : '全部项目'}</h2><button className="text-button" disabled={busy} onClick={() => void create()}><Plus size={16}/>新建项目</button></div>
      {filtered.length ? <div className="v1-projects">{filtered.map(p => <button className="v1-project" disabled={busy} key={p.id} onClick={() => void open(p.id)}><div className="v1-project-cover"><Layers size={30}/><ArrowUpRight size={18}/></div><strong>{p.name}</strong><time dateTime={p.updatedAt}>{new Date(p.updatedAt).toLocaleDateString('zh-CN')}</time></button>)}</div> : <div className="v1-empty"><FolderOpen size={28}/><span>{search ? '未找到项目' : '暂无项目'}</span></div>}
      </section>
    </div></main>
  </div>;
}
