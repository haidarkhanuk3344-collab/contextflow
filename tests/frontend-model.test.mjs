import test from 'node:test';
import assert from 'node:assert/strict';
import { blankData, decodeProject, generationInput, mediaUrl, taskLabel, wouldCycle } from '../src/v1/model.ts';
const node = (id, kind = 'image') => ({ id, type: 'media', position: { x: 0, y: 0 }, data: { ...blankData(kind, id), userInput: '人物描述', modelId: 'test-model' } });
const project = nodes => ({ id: 'project', name: 'test', revision: 4, nodes, referenceEdges: [], viewport: { x: 0, y: 0, zoom: 1 }, updatedAt: '' });
test('普通素材连线不启用承接', () => {
  const p = project([node('a'), node('b')]); p.referenceEdges.push({ id: 'ab', source: 'a', target: 'b' });
  assert.equal(generationInput(p, p.nodes[1], 'request').context.enabled, false);
});
test('多参考与唯一承接来源独立提交，参数与版本保留', () => {
  const a = node('a'), b = node('b'); b.data.context = { enabled: true, sourceNodeId: 'a', sourceVersionId: 'v1' };
  b.data.mediaReferences = [{ assetVersionId: 'v2', role: 'reference' }, { assetVersionId: 'v3', role: 'reference' }];
  b.data.parameters = { size: '1536x1024' }; b.data.style.presetId = 'chinese_2d';
  const input = generationInput(project([a,b]), b, 'request');
  assert.equal(input.mediaReferences.length, 2); assert.equal(input.context.sourceNodeId, 'a'); assert.equal(input.context.sourceVersionId, 'v1'); assert.equal(input.parameters.size, '1536x1024'); assert.equal(input.style.presetId, 'chinese_2d'); assert.equal(input.projectRevision, 4);
});
test('拒绝跨类型、自指与循环承接', () => {
  const a = node('a'), b = node('b','video'); b.data.context = { enabled: true, sourceNodeId: 'a', sourceVersionId: null };
  assert.throws(() => generationInput(project([a,b]), b, 'r'));
  a.data.context = { enabled: true, sourceNodeId: 'a', sourceVersionId: null };
  assert.throws(() => generationInput(project([a]), a, 'r'));
  a.data.context.sourceNodeId = 'b'; b.data.kind = 'image';
  assert.equal(wouldCycle([a,b], 'a', 'b'), true);
});
test('空结果不显示已生成、未知任务状态保守处理', () => {
  assert.equal(taskLabel({ status: 'succeeded' }), '结果不可用');
  assert.equal(taskLabel({ status: 'unrecognized' }), '待确认');
  assert.equal(taskLabel({ status: 'succeeded', resultUrl: 'https://example.com/result.png' }), '已生成');
});
test('拒绝脚本、data及旧版未鉴权媒体URL', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', '/api/assets/legacy', '//evil.test/file']) assert.equal(mediaUrl(url), undefined);
  assert.equal(mediaUrl('/api/v1/assets/a/content'), '/api/v1/assets/a/content');
});
test('项目编解码保留参数，错误结构拒绝打开', () => {
  assert.deepEqual(decodeProject(project([node('a')])).nodes[0].data, node('a').data);
  assert.throws(() => decodeProject({ id: 'a', nodes: [] }));
});

test('上传元数据转换为受保护实体地址，空文件不伪造预览', async () => {
  const { normalizeAsset } = await import('../src/v1/model.ts');
  assert.equal(normalizeAsset({ id:'a', filename:'a.png', size:12 }).contentUrl, '/api/v1/assets/a/content');
  assert.equal(normalizeAsset({ id:'b', filename:null, size:0 }).contentUrl, undefined);
});
test('图片尺寸同时适配当前后端读取字段', () => {
  const a=node('a');a.data.parameters.size='1536x1024';
  assert.equal(generationInput(project([a]),a,'r').size,'1536x1024');
});
test('承接来源独立于参考连线，支持历史版本和无画面待处理', async () => {
  const { contextSubmissionIssue }=await import('../src/v1/model.ts');
  const a=node('a'),b=node('b'),c=node('c');b.data.context={enabled:true,sourceNodeId:'a',sourceVersionId:null};
  const p=project([a,b,c]);assert.equal(contextSubmissionIssue(p,b),null);
  a.data.adoptedVersionId='v1';assert.equal(contextSubmissionIssue(p,b),null);
  p.referenceEdges=[{id:'cb',source:'c',target:'b'}];assert.equal(contextSubmissionIssue(p,b),null);
  p.referenceEdges=[];b.data.context.sourceVersionId='v0';assert.equal(contextSubmissionIssue(p,b),null);
});

test('个人库参考按模型数量、媒体类型和用途验证', async () => {
  const { referenceIssue } = await import('../src/v1/model.ts');
  const image = { id:'img', mime:'image/png', contentUrl:'/api/v1/assets/img/content' };
  const video = { id:'vid', mime:'video/mp4', contentUrl:'/api/v1/assets/vid/content' };
  const model = { inputKinds:['text','image'], referenceCount:1, referenceRoles:['first_frame'] };
  assert.equal(referenceIssue(model,[{assetVersionId:'img',role:'first_frame'}],[image]),null);
  assert.ok(referenceIssue(model,[{assetVersionId:'img',role:'reference'}],[image]));
  assert.ok(referenceIssue(model,[{assetVersionId:'vid',role:'first_frame'}],[video]));
  assert.ok(referenceIssue(model,[{assetVersionId:'img',role:'first_frame'},{assetVersionId:'img',role:'first_frame'}],[image]));
  assert.ok(referenceIssue(model,[{assetVersionId:'missing',role:'first_frame'}],[image]));
});

test('视频必须主动选择首帧，承接来源不替代参考', async () => {
  const { videoSubmissionIssue } = await import('../src/v1/model.ts');
  const model = { id:'wan', inputKinds:['image'], referenceCount:1, referenceRoles:['first_frame'] };
  const caps = { videos:{ models:[model], resolutions:['720P'], durations:[2,5] } };
  const a = node('video','video'); a.data.modelId='wan';
  a.data.context={enabled:true,sourceNodeId:'previous',sourceVersionId:'result'};
  assert.equal(videoSubmissionIssue(a.data,caps,[]),'请选择首帧图片');
  const asset={id:'frame',mime:'image/png',contentUrl:'/api/v1/assets/frame/content'};
  a.data.mediaReferences=[{assetVersionId:'frame',role:'first_frame'}];
  assert.equal(videoSubmissionIssue(a.data,caps,[asset]),null);
  a.data.parameters={resolution:'480P'};
  assert.equal(videoSubmissionIssue(a.data,caps,[asset]),'请重新选择视频分辨率');
  a.data.parameters={duration:12};
  assert.equal(videoSubmissionIssue(a.data,caps,[asset]),'请重新选择视频时长');
});
test('视频草稿刷新后时长保留，请求无声且不传未实现画幅', async () => {
  const { videoParameters } = await import('../src/v1/model.ts');
  const caps={videos:{resolutions:['720P'],durations:[2,5]}};
  const a=node('v','video');
  assert.deepEqual(videoParameters(a.data,caps),{resolution:'720P',duration:5,audio:false});
  a.data.parameters={duration:2,resolution:'720P',ratio:'9:16',audio:true};
  const restored=decodeProject(JSON.parse(JSON.stringify(project([a]))));
  const current=restored.nodes[0];current.data.parameters=videoParameters(current.data,caps);
  const input=generationInput(restored,current,'r');
  assert.deepEqual(input.parameters,{resolution:'720P',duration:2,audio:false});
});
