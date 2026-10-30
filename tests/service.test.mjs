import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createService} from '../server/service.mjs';
import {buildRequest} from '../src/contextLink.ts';
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=';
function request(prompt='绿色玻璃瓶，米色背景',projectId='test-project',nodeId=randomUUID()){
 const node={id:nodeId,type:'image',data:{kind:'image',name:'测试图',originalPrompt:prompt,inheritEnabled:false}};
 return {projectId,nodeId,requestId:randomUUID(),nodes:[node],edges:[],size:'1024x1024',model:'doubao-seedream-5-0-flash-260915',finalText:buildRequest(node,[node],[]).finalText};
}
const response=()=>new Response(JSON.stringify({data:[{b64_json:image}]}),{headers:{'Content-Type':'application/json'}});
async function fixture(t,fetcher){const dir=await mkdtemp(path.join(os.tmpdir(),'studio-test-'));const s=await createService({directory:dir,getKey:()=> 'test-key',fetcher});t.after(async()=>{s.close();await s.flush();await rm(dir,{recursive:true,force:true});});return {s,dir};}
async function until(fn){const start=Date.now();while(!fn()){if(Date.now()-start>3000)throw Error('wait timeout');await new Promise(r=>setTimeout(r,10));}}
test('提交冻结请求；编辑原始输入不会改变执行内容',async t=>{
 let received;const {s}=await fixture(t,async(_u,o)=>{received=JSON.parse(o.body);return response();});
 const body=request();const original=body.finalText;const result=await s.submit(body);body.nodes[0].data.originalPrompt='后来修改';await until(()=>s.tasks()[0].status==='succeeded');
 assert.equal(received.prompt,original);assert.equal(s.tasks()[0].snapshot.nodeRawPrompt,'绿色玻璃瓶，米色背景');assert.equal(result.status,'queued');assert.equal(s.assets().length,1);
});
test('两个节点同时提交按队列执行；同节点和同请求防重',async t=>{
 const releases=[];let calls=0;const {s}=await fixture(t,async()=>{calls++;await new Promise(r=>releases.push(r));return response();});
 const a=request();await s.submit(a);await s.submit(a);await assert.rejects(s.submit({...a,requestId:randomUUID()}),e=>e.code==='BUSY');await s.submit(request());await until(()=>calls===1);
 assert.equal(s.summary().running,1);assert.equal(s.summary().queued,1);releases.shift()();await until(()=>calls===2);releases.shift()();await until(()=>s.tasks().every(x=>x.status==='succeeded'));assert.equal(calls,2);
});
test('排队取消不触发模型；暂停与恢复正常',async t=>{
 let calls=0;const {s}=await fixture(t,async()=>{calls++;return response();});await s.control({paused:true});const task=await s.submit(request());assert.equal(calls,0);await s.cancel(task.id);await s.control({paused:false});assert.equal(calls,0);assert.equal(s.tasks()[0].status,'cancelled');
});
test('预算同时包含已发送及排队保留金额，超过上限拒绝',async t=>{
 const {s}=await fixture(t,async()=>response());await s.control({paused:true});for(let i=0;i<33;i++)await s.submit(request());await assert.rejects(s.submit(request()),e=>e.code==='BUDGET');assert.equal(s.summary().reserved,9.9);
});
test('进程中断后运行中任务变为待确认，不重新请求',async _t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'studio-restart-'));let calls=0;const s=await createService({directory:dir,getKey:()=> 'test',fetcher:async()=>{calls++;await new Promise(()=>{});}});
 await s.submit(request());await until(()=>s.tasks()[0].sentAt);await s.flush();const restarted=await createService({directory:dir,getKey:()=> 'test',fetcher:async()=>{calls++;return response();}});
 assert.equal(restarted.tasks()[0].status,'uncertain');assert.equal(calls,1);restarted.close();s.close();await restarted.flush();await rm(dir,{recursive:true,force:true});
});
test('磁盘记录含结果与快照；素材上传校验真实文件类型',async t=>{
 const {s,dir}=await fixture(t,async()=>response());await s.submit(request());await until(()=>s.tasks()[0].status==='succeeded');await s.flush();const saved=JSON.parse(await readFile(path.join(dir,'state.json'),'utf8'));assert.equal(saved.tasks[0].status,'succeeded');assert.equal(saved.assets.length,1);await assert.rejects(s.saveImage(Buffer.from('<html>invalid image</html>'),'fake.png'),e=>e.code==='IMAGE');
});
test('编辑另存为新素材并记录来源与参数，不覆盖原图',async t=>{
 const {s}=await fixture(t,async()=>response());const bytes=Buffer.from(image,'base64');const original=await s.saveImage(bytes,'商品原图','upload',{projectId:'p1'});const edited=await s.saveImage(bytes,'商品原图 · 编辑版','edited',{projectId:'p1',sourceAssetId:original.id,editParams:'{"ratio":"1:1"}'});
 assert.equal(s.assets().length,2);assert.equal(edited.sourceAssetId,original.id);assert.notEqual(edited.id,original.id);assert.equal(edited.kind,'edited');assert.ok(edited.editParams.includes('1:1'));assert.equal(s.assets().find(a=>a.id===original.id).name,'商品原图');
});
test('视频节点：创建异步任务、轮询、下载 MP4 并落盘',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'studio-video-'));let polls=0;
 const videoBytes=Buffer.concat([Buffer.from('xxxxftypisom'),Buffer.alloc(200)]);
 const fetcher=async(url,opts)=>{
  const u=String(url);
  if(u.endsWith('/contents/generations/tasks')&&opts?.method==='POST')return new Response(JSON.stringify({id:'ark-1'}),{headers:{'Content-Type':'application/json'}});
  if(u.includes('/tasks/ark-1')){polls++;return new Response(JSON.stringify({status:polls<2?'running':'succeeded',content:{video_url:'https://cdn.example.com/v.mp4'}}),{headers:{'Content-Type':'application/json'}});}
  if(u==='https://cdn.example.com/v.mp4')return new Response(videoBytes,{headers:{'Content-Type':'video/mp4'}});
  throw new Error('unexpected '+u);
 };
 const s=await createService({directory:dir,getKey:()=> 'img-key',getVideoKey:()=> 'video-key',getVideoModel:()=> 'doubao-seedance-1-0-pro-250528',videoPollInterval:10,fetcher});
 t.after(async()=>{s.close();await s.flush();await rm(dir,{recursive:true,force:true});});
 const nodeId=randomUUID();const node={id:nodeId,type:'video',data:{kind:'video',name:'镜头1',originalPrompt:'雨夜街道，镜头缓慢推进',inheritEnabled:false,videoResolution:'720p',videoRatio:'16:9',videoDuration:5}};
 const body={projectId:'p-video',nodeId,requestId:randomUUID(),scenario:'drama',nodes:[node],edges:[],finalText:buildRequest(node,[node],[]).finalText,size:'',model:''};
 await s.submit(body);await until(()=>s.tasks()[0].status==='succeeded');
 const task=s.tasks()[0];assert.equal(task.status,'succeeded');assert.equal(task.providerTaskId,'ark-1');assert.equal(task.snapshot.kind,'video');assert.equal(polls,2);
 const asset=s.assets()[0];assert.equal(asset.kind,'video');assert.equal(asset.ext,'mp4');assert.equal(asset.mime,'video/mp4');
});
test('视频节点未配置密钥或模型时拒绝，不调用模型',async t=>{
 const {s}=await fixture(t,async()=>{throw Error('should not call');});
 const nodeId=randomUUID();const node={id:nodeId,type:'video',data:{kind:'video',name:'镜头1',originalPrompt:'描述',inheritEnabled:false}};
 const body={projectId:'p',nodeId,requestId:randomUUID(),nodes:[node],edges:[],finalText:'描述',size:'',model:''};
 await assert.rejects(s.submit(body),e=>e.code==='VIDEO_CONFIG');
});
test('图生视频：首帧图片转为 base64 data URL 传入',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'studio-i2v-'));let captured;
 const imgBytes=Buffer.from(image,'base64');
 const videoBytes=Buffer.concat([Buffer.from('xxxxftypisom'),Buffer.alloc(100)]);
 const fetcher=async(url,opts)=>{
  const u=String(url);
  if(u.endsWith('/contents/generations/tasks')&&opts?.method==='POST'){captured=JSON.parse(opts.body);return new Response(JSON.stringify({id:'ark-2'}),{headers:{'Content-Type':'application/json'}});}
  if(u.includes('/tasks/ark-2'))return new Response(JSON.stringify({status:'succeeded',content:{video_url:'https://cdn.example.com/v2.mp4'}}),{headers:{'Content-Type':'application/json'}});
  if(u==='https://cdn.example.com/v2.mp4')return new Response(videoBytes,{headers:{'Content-Type':'video/mp4'}});
  throw new Error('unexpected '+u);
 };
 const s=await createService({directory:dir,getKey:()=> 'img-key',getVideoKey:()=> 'video-key',getVideoModel:()=> 'm',videoPollInterval:10,fetcher});
 t.after(async()=>{s.close();await s.flush();await rm(dir,{recursive:true,force:true});});
 const frame=await s.saveImage(imgBytes,'首帧','generated',{projectId:'p'});
 const nodeId=randomUUID();const node={id:nodeId,type:'video',data:{kind:'video',name:'镜头1',originalPrompt:'镜头缓慢推进',inheritEnabled:false,referenceAssetId:frame.id}};
 const body={projectId:'p',nodeId,requestId:randomUUID(),nodes:[node],edges:[],finalText:buildRequest(node,[node],[]).finalText,size:'',model:''};
 await s.submit(body);await until(()=>s.tasks()[0].status==='succeeded');
 const item=captured.content.find(c=>c.type==='image_url');
 assert.ok(item,'应有首帧 image_url');assert.equal(item.role,'first_frame');assert.ok(item.image_url.url.startsWith('data:image/png;base64,'));
});
test('图生图：带参考图走 edits 接口并传 images base64；无参考图走 generations',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'studio-i2i-'));const calls=[];
 const fetcher=async(url,opts)=>{calls.push({url:String(url),body:opts?.body?JSON.parse(opts.body):null});return response();};
 const s=await createService({directory:dir,getKey:()=> 'k',fetcher});
 t.after(async()=>{s.close();await s.flush();await rm(dir,{recursive:true,force:true});});
 // 先存一张参考图
 const ref=await s.saveImage(Buffer.from(image,'base64'),'参考图','upload',{projectId:'p'});
 // 图生图
 const n1=randomUUID();const node1={id:n1,type:'image',data:{kind:'image',name:'图生图',originalPrompt:'改成黑色',inheritEnabled:false,referenceAssetId:ref.id}};
 await s.submit({projectId:'p',nodeId:n1,requestId:randomUUID(),nodes:[node1],edges:[],finalText:'改成黑色',size:'1024x1024',model:'doubao-seedream-5-0-flash-260915'});
 await until(()=>s.tasks().every(x=>x.status==='succeeded'));
 const editCall=calls.find(c=>c.url.endsWith('/images/edits'));
 assert.ok(editCall,'应调用 edits 接口');
 assert.ok(editCall.body.images,'edits 应带 images 字段');
 assert.ok(editCall.body.images[0].image_url.startsWith('data:image/png;base64,'),'应传 base64 data URL');
 // 文生图
 const n2=randomUUID();const node2={id:n2,type:'image',data:{kind:'image',name:'文生图',originalPrompt:'一只猫',inheritEnabled:false}};
 await s.submit({projectId:'p',nodeId:n2,requestId:randomUUID(),nodes:[node2],edges:[],finalText:'一只猫',size:'1024x1024',model:'doubao-seedream-5-0-flash-260915'});
 await until(()=>s.tasks().every(x=>x.status==='succeeded'));
 assert.ok(calls.some(c=>c.url.endsWith('/images/generations')),'文生图应走 generations 接口');
});
