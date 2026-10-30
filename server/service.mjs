import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { buildRequest, TEMPLATE_VERSION } from '../src/contextLink.ts';

export const MODELS=['doubao-seedream-5-0-flash-260915','doubao-seedream-5-0-pro-260628','doubao-seedream-4-0-20260415'];
export const SIZES=['1024x1024','1536x1024','1024x1536'];
export class ApiError extends Error {constructor(code,message,status=400){super(message);this.code=code;this.status=status;}}
export function imageInfo(bytes){
 if(bytes.length<16)throw new ApiError('IMAGE','文件不是有效图片。');
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {ext:'png',mime:'image/png',width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
 if(bytes[0]===255&&bytes[1]===216)return {ext:'jpg',mime:'image/jpeg'};
 if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return {ext:'webp',mime:'image/webp'};
 throw new ApiError('IMAGE','仅支持真实 PNG、JPEG、WebP 图片。');
}
const active=s=>['queued','running'].includes(s);
export async function createService({directory,getKey,getVideoKey=()=>'',getVideoBaseUrl=()=>'https://ark.cn-beijing.volces.com/api/v3',getVideoModel=()=>'',fetcher=fetch,endpoint='https://ark.cn-beijing.volces.com/api/v3/images/generations',timeout=300000,videoTimeout=900000,videoPollInterval=8000,limit=10}){
 await mkdir(directory,{recursive:true});const file=path.join(directory,'state.json');
 let state={tasks:[],assets:[],paused:false,concurrency:1,budgetLimit:limit};
 try{const loaded=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(loaded.tasks)||!Array.isArray(loaded.assets))throw Error('schema');state={...state,...loaded,budgetLimit:limit};}catch(e){if(e.code!=='ENOENT')throw Error('本地状态无法读取，已停止以保护记录。');}
 let writeQueue=Promise.resolve();
 const persist=()=>{const data=JSON.stringify(state,null,2);const job=writeQueue.then(async()=>{await writeFile(file+'.tmp',data,{mode:0o600});await rename(file+'.tmp',file);});writeQueue=job.catch(()=>{});return job;};
 for(const task of state.tasks)if(task.status==='running'){task.status='uncertain';task.error='服务重启时任务仍在执行，结果待确认。不会自动重新调用模型。';task.finishedAt=new Date().toISOString();}
 await persist();
 let gate=Promise.resolve(),running=0,closed=false;
 const controllers=new Map();
 const spent=()=>state.tasks.filter(t=>t.sentAt).reduce((n,t)=>n+t.estimatedCost,0);
 const reserved=()=>state.tasks.filter(t=>active(t.status)&&!t.sentAt).reduce((n,t)=>n+t.estimatedCost,0);
 const summary=()=>({paused:state.paused,concurrency:state.concurrency,running,queued:state.tasks.filter(t=>t.status==='queued').length,estimatedSpent:Number(spent().toFixed(2)),reserved:Number(reserved().toFixed(2)),budgetLimit:state.budgetLimit});
 const tasks=(projectId)=>structuredClone(state.tasks.filter(t=>!projectId||t.projectId===projectId));
 const assets=()=>structuredClone(state.assets);
 const saveImage=async(bytes,name,kind='upload',meta={})=>{const info=imageInfo(bytes);const id=randomUUID();const filename=id+'.'+info.ext;await writeFile(path.join(directory,filename),bytes);const asset={id,name:String(name||'未命名素材').slice(0,100),kind,url:'/api/results/'+filename,...info,...meta,createdAt:new Date().toISOString()};state.assets.unshift(asset);await persist();return structuredClone(asset);};
 const saveVideo=async(bytes,name,meta={})=>{if(bytes.length<16||bytes.toString('ascii',4,8)!=='ftyp')throw new ApiError('VIDEO','模型未返回有效的 MP4 视频。');const id=randomUUID();const filename=id+'.mp4';await writeFile(path.join(directory,filename),bytes);const asset={id,name:String(name||'未命名视频').slice(0,100),kind:'video',url:'/api/results/'+filename,ext:'mp4',mime:'video/mp4',...meta,createdAt:new Date().toISOString()};state.assets.unshift(asset);await persist();return structuredClone(asset);};
 const readVideoUrl=content=>{if(!content)return undefined;if(!Array.isArray(content)&&typeof content.video_url==='string'&&content.video_url)return content.video_url;if(Array.isArray(content)){for(const item of content){if(item?.video_url?.url)return item.video_url.url;}}return undefined;};
 const sleep=(ms,controller)=>new Promise((res,rej)=>{const t=setTimeout(res,ms);t.unref?.();controller?.signal?.addEventListener('abort',()=>{clearTimeout(t);rej(controller.signal.reason||new Error('aborted'));},{once:true});});
 const runImage=async(task,controller)=>{
  const refAsset=task.snapshot.referenceAssetId?state.assets.find(a=>a.id===task.snapshot.referenceAssetId):undefined;
  const isEdit=!!refAsset;
  let requestBody;
  if(isEdit){
   const bytes=await readFile(path.join(directory,path.basename(refAsset.url)));
   const mime=refAsset.ext==='jpg'?'jpeg':refAsset.ext;
   requestBody={model:task.snapshot.model,images:[{image_url:`data:image/${mime};base64,${bytes.toString('base64')}`}],prompt:task.snapshot.finalText,size:task.snapshot.size,n:1};
  }else{
   requestBody={model:task.snapshot.model,prompt:task.snapshot.finalText,size:task.snapshot.size,n:1};
  }
  const targetUrl=isEdit?endpoint.replace(/generations$/,'edits'):endpoint;
  const response=await fetcher(targetUrl,{method:'POST',headers:{Authorization:'Bearer '+getKey(),'Content-Type':'application/json'},body:JSON.stringify(requestBody),signal:controller.signal});
  if(!response.ok){if(response.status>=500)throw new ApiError('UNCERTAIN','服务商异常，无法确定是否已计费；请核对服务商记录。');throw new ApiError('PROVIDER',response.status===401||response.status===403?'接口认证失败，请检查生图分组密钥。':'模型接口返回 '+response.status+'，请检查模型权限、参数及余额。');}
  const raw=await response.text();if(raw.length>60_000_000)throw new ApiError('UNCERTAIN','模型返回内容过大。');
  const body=JSON.parse(raw),item=body.data?.[0];let bytes;
  if(item?.b64_json)bytes=Buffer.from(item.b64_json,'base64');
  else if(item?.url){
   const u=new URL(item.url);if(u.protocol!=='https:')throw new ApiError('UNCERTAIN','服务商返回的图片链接无效。');
   const r=await fetcher(u,{signal:controller.signal});if(!r.ok)throw new ApiError('UNCERTAIN','模型已返回结果，但图片下载失败。');bytes=Buffer.from(await r.arrayBuffer());
  }else throw new ApiError('UNCERTAIN','模型未返回可用图片。');
  if(bytes.length>40_000_000)throw new ApiError('UNCERTAIN','返回图片超过大小限制。');
  if(task.status==='cancelled')return;
  const asset=await saveImage(bytes,task.nodeName,'generated',{projectId:task.projectId,nodeId:task.nodeId,taskId:task.id,model:task.snapshot.model});
  task.resultUrl=asset.url;task.assetId=asset.id;task.width=asset.width;task.height=asset.height;
 };
 const runVideo=async(task,controller)=>{
  const base=getVideoBaseUrl().replace(/\/+$/,'');const headers={Authorization:'Bearer '+getVideoKey(),'Content-Type':'application/json'};
  const p=task.snapshot.videoParams||{};
  const content=[];
  if(task.snapshot.referenceAssetId){
   const ref=state.assets.find(a=>a.id===task.snapshot.referenceAssetId);
   if(ref&&ref.ext!=='mp4'){
    const bytes=await readFile(path.join(directory,path.basename(ref.url)));
    const mime=ref.ext==='jpg'?'jpeg':ref.ext;
    content.push({type:'image_url',role:'first_frame',image_url:{url:`data:image/${mime};base64,${bytes.toString('base64')}`}});
   }
  }
  content.push({type:'text',text:task.snapshot.finalText});
  const createRes=await fetcher(base+'/contents/generations/tasks',{method:'POST',headers,body:JSON.stringify({model:task.snapshot.model,content,resolution:p.resolution||'720p',ratio:p.ratio||'16:9',duration:Number(p.duration)||5,watermark:false,generate_audio:false}),signal:controller.signal});
  if(!createRes.ok){const t=await createRes.text().catch(()=>'');throw new ApiError(createRes.status===401||createRes.status===403?'PROVIDER':'PROVIDER',createRes.status===401||createRes.status===403?'视频接口认证失败，请检查 API 密钥。':'视频任务创建失败 '+createRes.status+'：'+t.slice(0,200));}
  const created=await createRes.json();task.providerTaskId=created.id;
  if(!task.providerTaskId)throw new ApiError('UNCERTAIN','视频接口未返回任务编号。');
  await persist();
  while(true){
   if(controller.signal.aborted||task.status==='cancelled')return;
   const q=await fetcher(base+'/contents/generations/tasks/'+task.providerTaskId,{headers,signal:controller.signal});
   if(!q.ok){if(q.status>=500)throw new ApiError('UNCERTAIN','视频查询服务异常，结果待确认。');throw new ApiError('PROVIDER','视频查询失败 '+q.status+'，请核对任务状态。');}
   const data=await q.json();const st=String(data.status||'');
   if(st==='succeeded'||st==='success'){
    const url=readVideoUrl(data.content);if(!url)throw new ApiError('UNCERTAIN','视频任务成功但未返回视频地址。');
    const vr=await fetcher(url,{signal:controller.signal});if(!vr.ok)throw new ApiError('UNCERTAIN','视频已生成但下载失败。');
    const bytes=Buffer.from(await vr.arrayBuffer());if(bytes.length>200_000_000)throw new ApiError('UNCERTAIN','视频文件过大。');
    const asset=await saveVideo(bytes,task.nodeName,{projectId:task.projectId,nodeId:task.nodeId,taskId:task.id,model:task.snapshot.model});
    task.resultUrl=asset.url;task.assetId=asset.id;return;
   }
   if(st==='failed')throw new ApiError('PROVIDER',data.error?.message||data.error?.code||'视频生成失败');
   if(st==='cancelled'||st==='canceled'||st==='expired'){task.status='cancelled';return;}
   await sleep(videoPollInterval,controller);
  }
 };
 const run=async(task)=>{
  running++;const controller=new AbortController();controllers.set(task.id,controller);let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},task.snapshot.kind==='video'?videoTimeout:timeout);timer.unref?.();
  try{
   task.status='running';task.startedAt=new Date().toISOString();await persist();
   if(task.status==='cancelled')return;
   task.sentAt=new Date().toISOString();await persist();
   if(task.snapshot.kind==='video')await runVideo(task,controller);else await runImage(task,controller);
   if(task.status==='cancelled')return;
   task.status='succeeded';
  }catch(e){
   if(task.status!=='cancelled'){task.status=e instanceof ApiError&&e.code==='PROVIDER'?'failed':'uncertain';task.error=e instanceof ApiError?e.message:timedOut?'模型请求超时，结果待确认；不会自动重新调用。':'网络中断或返回格式异常，结果待确认；不会自动重新调用。';}
  }finally{
   clearTimeout(timer);controllers.delete(task.id);task.finishedAt=new Date().toISOString();task.updatedAt=task.finishedAt;task.durationMs=Date.parse(task.finishedAt)-Date.parse(task.startedAt);
   try{await persist();}catch{task.status='uncertain';task.error='本机保存失败，请检查磁盘，勿重复提交。';}
   running--;schedule();
  }
 };
 function schedule(){if(closed||state.paused)return;for(const task of state.tasks.filter(t=>t.status==='queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))){if(running>=state.concurrency)break;task.status='running';void run(task);}}
 const serial=fn=>{const job=gate.then(fn);gate=job.catch(()=>{});return job;};
 const submit=body=>serial(async()=>{
  if(!body||typeof body.projectId!=='string'||body.projectId.length>100||typeof body.nodeId!=='string'||typeof body.requestId!=='string'||! /^[a-f0-9-]{36}$/.test(body.requestId))throw new ApiError('INPUT','任务标识格式错误。');
  const existing=state.tasks.find(t=>t.id===body.requestId);if(existing){if(existing.projectId!==body.projectId||existing.nodeId!==body.nodeId)throw new ApiError('CONFLICT','请求编号冲突。',409);return structuredClone(existing);}
  if(state.tasks.some(t=>t.projectId===body.projectId&&t.nodeId===body.nodeId&&active(t.status)))throw new ApiError('BUSY','当前节点已有活动任务。',409);
  if(!Array.isArray(body.nodes)||!Array.isArray(body.edges)||body.nodes.length>500||body.edges.length>500)throw new ApiError('INPUT','画布数据无效。');
  const node=body.nodes.find(n=>n.id===body.nodeId);if(!node||typeof node.data?.originalPrompt!=='string')throw new ApiError('INPUT','节点不存在或缺少描述。');
  const kind=node.data.kind||node.type;const isVideo=kind==='video';
  if(isVideo){
   if(!getVideoKey())throw new ApiError('VIDEO_CONFIG','请先配置视频 API 密钥。',409);
   if(!getVideoModel())throw new ApiError('VIDEO_CONFIG','请先填写视频模型 ID。',409);
  }else if(kind!=='image'){
   throw new ApiError('VIDEO_CONFIG','暂不支持该节点类型。',409);
  }else{
   if(!getKey())throw new ApiError('CONFIG','请先配置图片 API 密钥。',409);
   if(!MODELS.includes(body.model||'doubao-seedream-5-0-flash-260915'))throw new ApiError('MODEL','请选择已支持的图片模型。');
   if(!SIZES.includes(body.size))throw new ApiError('SIZE','图片尺寸不受支持。');
  }
  const request=buildRequest(node,body.nodes,body.edges);if(!request.valid)throw new ApiError('PROMPT',request.issues.join(' '));
  if(request.finalText!==body.finalText)throw new ApiError('STALE','当前内容与请求预览不同，请重新检查。',409);
  if(spent()+reserved()+.3>state.budgetLimit+.00001)throw new ApiError('BUDGET','已达到本次 ¥10 模型测试预算上限。',409);
  const now=new Date().toISOString();const task={id:body.requestId,projectId:body.projectId,nodeId:body.nodeId,nodeName:node.data.name,scenario:body.scenario||'general',status:'queued',createdAt:now,updatedAt:now,estimatedCost:.3,snapshot:{kind:isVideo?'video':'image',finalText:request.finalText,templateVersion:TEMPLATE_VERSION,nodeRawPrompt:node.data.originalPrompt,inheritEnabled:node.data.inheritEnabled,predecessorNodeId:request.inherited?.id,predecessorName:request.inherited?.data.name,predecessorRawPrompt:request.inherited?.data.originalPrompt,model:isVideo?getVideoModel():(body.model||'doubao-seedream-5-0-flash-260915'),size:body.size,n:1,mode:'real',referenceAssetId:node.data.referenceAssetId||null,referenceMode:node.data.referenceAssetId?'image':'text-only',...(isVideo?{videoParams:{resolution:node.data.videoResolution||'720p',ratio:node.data.videoRatio||'16:9',duration:Number(node.data.videoDuration)||5}}:{})}};
  state.tasks.push(task);try{await persist();}catch{state.tasks=state.tasks.filter(t=>t!==task);throw new ApiError('SAVE','提交保存失败，未调用模型。',503);}
  const reply=structuredClone(task);schedule();return reply;
 });
 const cancel=id=>serial(async()=>{const task=state.tasks.find(t=>t.id===id);if(!task)throw new ApiError('NOT_FOUND','任务不存在。',404);if(!active(task.status))throw new ApiError('STATE','该任务已结束。',409);task.status='cancelled';task.error=task.sentAt?'已停止等待；模型端可能仍执行或计费，取消不保证退款。':'排队任务已取消，未调用模型。';task.updatedAt=new Date().toISOString();controllers.get(id)?.abort();await persist();return structuredClone(task);});
 const control=body=>serial(async()=>{if(typeof body.paused==='boolean')state.paused=body.paused;if(body.concurrency!==undefined){if(![1,2].includes(body.concurrency))throw new ApiError('INPUT','并行数只支持 1 或 2。');state.concurrency=body.concurrency;}await persist();schedule();return summary();});
 const close=()=>{closed=true;for(const c of controllers.values())c.abort();};
 schedule();return {submit,cancel,control,tasks,assets,summary,saveImage,close,flush:()=>writeQueue};
}
