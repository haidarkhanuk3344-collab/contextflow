import { blankData, decodeProject } from './model';
import type { Asset, Category, Project, Task } from './model';

type DemoTask = Task & { projectId: string; demoPrompt?: string };
type State = { projects: Project[]; assets: Asset[]; tasks: DemoTask[]; categories: Category[] };
const dbName = 'contextflow-public-demo-v1';
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const styles = [{ id: 'period_realistic', name: '古装真人' }, { id: 'modern_realistic', name: '现代真人' }, { id: 'chinese_2d', name: '中式二维' }, { id: 'game_cg', name: '游戏CG' }];
let state: State | null = null;
let queue: Promise<unknown> = Promise.resolve();
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(dbName, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('state');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(new Error('浏览器未允许本地存储'));
  });
}
async function read(): Promise<State | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => { const tx = db.transaction('state'); const r = tx.objectStore('state').get('main'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); tx.oncomplete = () => db.close(); });
}
async function persist(s: State) {
  const db = await database();
  await new Promise<void>((resolve, reject) => { const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(s, 'main'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(new Error('本地保存失败，请检查浏览器存储空间')); }; });
}
function draw(text: string, style = 'chinese_2d', inherited = false, progress = 0) {
  const c = document.createElement('canvas'); c.width = 960; c.height = 600;
  const x = c.getContext('2d')!;
  const colors: Record<string, string[]> = { period_realistic: ['#302b28','#bca77e','#5b655a'], modern_realistic: ['#24313d','#afbec7','#526e81'], chinese_2d: ['#213c3c','#d9cba5','#577b70'], game_cg: ['#282b42','#a8b4ca','#555d8d'] };
  const p = colors[style] || colors.chinese_2d;
  const g = x.createLinearGradient(0,0,0,600); g.addColorStop(0,p[0]); g.addColorStop(1,p[2]); x.fillStyle=g; x.fillRect(0,0,960,600);
  x.fillStyle=p[1]; x.beginPath(); x.arc(710+progress*12,140,52,0,Math.PI*2); x.fill();
  for(let i=0;i<4;i++){ x.fillStyle=i%2?p[0]:p[2]; x.globalAlpha=.35+i*.16; x.beginPath(); x.moveTo(-50,600); for(let j=0;j<7;j++)x.lineTo(j*190-50,240+i*55+Math.sin(j*2.1+i+progress*.15)*95); x.lineTo(1050,600); x.fill(); }
  x.globalAlpha=1; x.fillStyle=p[1]; x.fillRect(160,320,6,110); x.fillRect(300,320,6,110); x.beginPath();x.moveTo(120,320);x.lineTo(234,265);x.lineTo(348,320);x.closePath();x.fill();x.fillRect(140,430,186,5);
  x.fillStyle='#ffffff';x.font='16px sans-serif';x.fillText('CONTEXTFLOW / DEMO',34,40);
  x.font='26px sans-serif'; x.fillText(text.slice(0,30) || '山间 · 光影',34,530);
  x.font='16px sans-serif';x.fillStyle='#ffffffbb';x.fillText(inherited?'承接流程示意 · 非 AI 生成':'预设画面示意 · 非 AI 生成',34,565);
  return c;
}
async function video(text: string, style: string, inherited: boolean): Promise<string> {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('当前浏览器不支持动画演示，请体验图片演示');
  const c=draw(text,style,inherited); const stream=c.captureStream(12); const recorder=new MediaRecorder(stream,{mimeType:'video/webm'}); const chunks: BlobPart[]=[];
  return new Promise((resolve,reject)=>{
    let timer: ReturnType<typeof setInterval>;
    recorder.ondataavailable=e=>chunks.push(e.data);
    recorder.onerror=()=>{clearInterval(timer);stream.getTracks().forEach(t=>t.stop());reject(new Error('动画演示失败'));};
    recorder.onstop=()=>{clearInterval(timer);stream.getTracks().forEach(t=>t.stop());const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('动画保存失败'));reader.readAsDataURL(new Blob(chunks,{type:'video/webm'}));};
    recorder.start(); let frame=0;timer=setInterval(()=>{c.getContext('2d')!.drawImage(draw(text,style,inherited,frame/12),0,0);if(++frame>=24)recorder.stop();},1000/12);
  });
}
function seed(): State {
  const a='demo-image-1', b='demo-image-2', p='demo-project';
  const first={...blankData('image','镜头 01 · 山间远景'),userInput:'青山之间的一座亭子，晨雾，暖色天光',modelId:'demo-image',parameters:{size:'1024x1024'},style:{presetId:'chinese_2d',customDescription:null},adoptedVersionId:a};
  const second={...blankData('image','镜头 02 · 延续氛围'),userInput:'镜头向亭子靠近，保持清晨的氛围',modelId:'demo-image',parameters:{size:'1024x1024'},style:{presetId:'chinese_2d',customDescription:null},context:{enabled:true,sourceNodeId:'scene-1',sourceVersionId:a},adoptedVersionId:b};
  return {projects:[{id:p,name:'山间来信 · 承接演示',revision:1,updatedAt:now(),viewport:{x:100,y:150,zoom:.85},referenceEdges:[{id:'demo-edge',source:'scene-1',target:'scene-2'}],nodes:[{id:'scene-1',type:'media',position:{x:0,y:0},data:first},{id:'scene-2',type:'media',position:{x:480,y:0},data:second}]}],assets:[{id:a,name:'山间远景 · 示例',kind:'generated',nodeId:'scene-1',projectId:p,mime:'image/png',contentUrl:draw(first.userInput).toDataURL(),createdAt:now()},{id:b,name:'延续氛围 · 示例',kind:'generated',nodeId:'scene-2',projectId:p,mime:'image/png',contentUrl:draw(second.userInput,'chinese_2d',true).toDataURL(),createdAt:now()}],tasks:[],categories:[]};
}
async function handle(path: string, method: string, body?: unknown): Promise<unknown> {
  if(!state) state=await read() || seed();
  // Work on a copy so failed persistence never leaves acknowledged in-memory edits.
  const s=structuredClone(state); const u=new URL(path,'https://demo.invalid');
  const b=(body || {}) as Record<string, any>;
  let result: unknown;
  if(path==='/me') return {user:{id:'demo-user',name:'本地演示'},quota:{budget:0,used:0}};
  if(path.startsWith('/auth/') || path==='/admin/invite') throw new Error('演示版免登录，不提供账号管理');
  if(path==='/capabilities') return {runtime:{imageGeneration:true,videoGeneration:true,assetUpload:true,context:true},images:{models:[{id:'demo-image',name:'图片演示 · 不调用模型',inputKinds:['image','text'],referenceCount:1,referenceRoles:['reference']}],sizes:['1024x1024','1536x1024','1024x1536']},videos:{models:[{id:'demo-video',name:'动画演示 · 不调用模型',inputKinds:['image'],referenceCount:1,referenceRoles:['first_frame']}],resolutions:['720P'],ratios:['16:9'],durations:[2]}};
  if(path==='/styles') return {styles};
  if(u.pathname==='/projects' && method==='GET') return {projects:s.projects};
  if(u.pathname==='/projects' && method==='POST') {const project: Project={id:uid(),name:String(b.name || '未命名项目'),revision:1,nodes:[],referenceEdges:[],viewport:{x:0,y:0,zoom:1},updatedAt:now()};s.projects.unshift(project);result={project};}
  else if(u.pathname.startsWith('/projects/')) {const id=u.pathname.split('/')[2];const p=s.projects.find(p=>p.id===id);if(!p)throw new Error('本地项目不存在');if(method==='GET')return {project:p};if(b.expectedRevision!==p.revision)throw new Error('画布已更新，请刷新后重试');const project=decodeProject({...p,...b,revision:p.revision+1,updatedAt:now()});s.projects=s.projects.map(p=>p.id===id?project:p);result={project};}
  else if(u.pathname==='/assets' && method==='POST') {if(typeof b.dataUrl!=='string' || !/^data:(image\/(png|jpeg|webp)|video\/mp4);base64,/.test(b.dataUrl))throw new Error('仅支持 PNG、JPG、WebP、MP4');const asset:Asset={id:uid(),name:String(b.name || '素材'),kind:'upload',mime:b.mime,contentUrl:b.dataUrl,categoryId:b.categoryId,createdAt:now()};s.assets.push(asset);result={assetVersion:asset};}
  else if(u.pathname==='/assets' || u.pathname==='/library/assets') return {assets:s.assets.filter(a=>u.pathname.startsWith('/library')?a.kind==='upload':a.projectId===u.searchParams.get('projectId'))};
  else if(/^\/assets\/[^/]+\/category$/.test(u.pathname)) {const asset=s.assets.find(a=>a.id===u.pathname.split('/')[2]);if(!asset)throw new Error('素材不存在');asset.categoryId=b.categoryId;result={assetVersion:asset};}
  else if(u.pathname==='/categories' && method==='GET') return {categories:s.categories};
  else if(u.pathname==='/categories' && method==='POST') {const category={id:uid(),name:String(b.name),createdAt:now()};s.categories.push(category);result={category};}
  else if(u.pathname.startsWith('/categories/')) {const id=u.pathname.split('/')[2];const category=s.categories.find(c=>c.id===id);if(!category)throw new Error('分类不存在');if(method==='DELETE'){s.categories=s.categories.filter(c=>c.id!==id);s.assets.forEach(a=>{if(a.categoryId===id)a.categoryId=null;});result={ok:true};}else{category.name=String(b.name);result={category};}}
  else if(u.pathname==='/tasks') return {tasks:s.tasks.filter(t=>t.projectId===u.searchParams.get('projectId'))};
  else if(u.pathname==='/generations') {
    const existing=s.tasks.find(t=>t.requestId===b.requestId);if(existing)return {task:existing};
    const p=s.projects.find(p=>p.id===b.projectId);const n=p?.nodes.find(n=>n.id===b.nodeId);if(!p || !n)throw new Error('节点不存在');
    const predecessor=n.data.context.enabled?p.nodes.find(v=>v.id===n.data.context.sourceNodeId):undefined;
    const inherited=!!predecessor;const prompt=inherited?`前序：${predecessor.data.userInput}\n当前：${b.text}`:String(b.text);
    const contentUrl=b.kind==='video'?await video(String(b.text),b.style?.presetId,inherited):draw(String(b.text),b.style?.presetId,inherited).toDataURL();
    const asset:Asset={id:uid(),name:`${n.data.name} · 演示结果`,nodeId:n.id,projectId:p.id,kind:'generated',mime:b.kind==='video'?'video/webm':'image/png',contentUrl,createdAt:now()};s.assets.push(asset);
    const task:DemoTask={id:uid(),requestId:b.requestId,nodeId:n.id,projectId:p.id,status:'succeeded',assetVersionId:asset.id,resultUrl:contentUrl,createdAt:now(),demoPrompt:prompt,frozenInput:{kind:b.kind}};s.tasks.unshift(task);result={task};
  } else throw new Error('演示版未提供此操作');
  await persist(s);state=s;return structuredClone(result);
}
export function demoRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
  const job=queue.then(()=>handle(path,method,body));queue=job.catch(()=>{});return job as Promise<T>;
}
