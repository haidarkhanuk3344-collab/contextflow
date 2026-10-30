import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { decodeProject } from './model';
import type { Project } from './model';
export function useProject(initial: Project) {
  const draftKey = `jingliu:draft:${initial.id}`;
  const [restored] = useState(() => { try { const value = sessionStorage.getItem(draftKey); if (value) return decodeProject(JSON.parse(value)); } catch { /* Bad local draft never replaces server data. */ } return initial; });
  const [project, setProject] = useState(restored);
  const latest = useRef(restored); const dirty = useRef(restored !== initial); const version = useRef(0);
  const queue = useRef<Promise<Project>>(Promise.resolve(initial)); const conflict = useRef(restored !== initial && restored.revision !== initial.revision);
  const [status, setStatus] = useState(restored !== initial ? '未保存' : '已保存'); const [error, setError] = useState(conflict.current ? '项目已更新，草稿尚未同步' : '');
  const change = useCallback((updater: (p: Project) => Project) => {
    const next = updater(latest.current); latest.current = next; dirty.current = true; version.current++; try { sessionStorage.setItem(draftKey, JSON.stringify(next)); } catch { /* In-memory draft and beforeunload remain available. */ } setProject(next); setStatus('未保存');
  }, [draftKey]);
  const save = useCallback(() => {
    const job = queue.current.catch(() => latest.current).then(async () => {
      if (conflict.current) throw new Error('项目已更新，请重新加载');
      if (!dirty.current) return latest.current;
      const input = latest.current; const start = version.current; setStatus('保存中');
      try {
        const saved = await api.save(input);
        latest.current = { ...latest.current, revision: saved.revision, updatedAt: saved.updatedAt };
        setProject(latest.current); dirty.current = start !== version.current;
        if (!dirty.current) sessionStorage.removeItem(draftKey);
        setStatus(dirty.current ? '未保存' : '已保存'); setError(''); return latest.current;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) conflict.current = true;
        setError((e as Error).message); setStatus('保存失败'); throw e;
      }
    }); queue.current = job; return job;
  }, [draftKey]);
  useEffect(() => { if (!dirty.current || conflict.current) return; const timer = setTimeout(() => void save().catch(() => {}), 700); return () => clearTimeout(timer); }, [project, save]);
  useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (dirty.current) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, []);
  const reload = async () => { const fresh = await api.project(initial.id); conflict.current = false; dirty.current = false; latest.current = fresh; sessionStorage.removeItem(draftKey); setProject(fresh); setError(''); setStatus('已保存'); };
  return { project, change, save, status, error, reload, conflict: conflict.current };
}
