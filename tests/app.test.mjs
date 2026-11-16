import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { cleanLead, sameCompany, csvParse, manualSearchPlan } from '../src/domain.mjs';
import { toXlsx, toCsv } from '../src/export.mjs';
import { publicConfig, assertNoSecrets, searchDgis, generateModel } from '../src/integrations.mjs';

// Entirely synthetic fixtures. Nothing is imported into the user's working database.
const fixture={name:'ТЕСТОВАЯ КОМПАНИЯ — не реальный лид',city:'Тестовый город',category:'Кафе',address:'Тестовый адрес, 1',phone:'+7 (000) 000-00-01',card_url:'https://2gis.ru/firm/10000000000000001',sources:['https://example.org/source'],notes:'Только тестовые данные'};
async function launch(env={}){
  const directory=mkdtempSync(join(tmpdir(),'kontur-test-'));
  const app=createApp({directory,env:{AI_PROVIDER:'none',DGIS_STORAGE_LICENSE_CONFIRMED:'false',...env}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+app.server.address().port;
  const state=await (await fetch(base+'/api/state')).json();
  const request=async(path,method='GET',data,headers={})=>{
    const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Local-Token':state.token,...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
    return {status:res.status,data:await res.json()};
  };
  return {app,base,request,directory};
}
async function finished(request,id){
  for(let i=0;i<60;i++){const {data}=await request('/api/runs/'+id);if(data.status!=='running')return data;await new Promise(r=>setTimeout(r,15));}
  throw Error('Test run did not finish');
}
const agent=(extra={})=>({name:'Тестовый агент',goal:'Проверить только выбранные материалы',instructions:'Не выдумывай факты.',expected_result:'Материалы с источниками',sources:['input'],tools:['read_input','create_report'],mode:'local',file_ids:[],...extra});

test('site absence cannot be asserted from an empty catalog field',()=>{
  const l=cleanLead(fixture);assert.equal(l.website_status,'manual');assert.equal(l.checked_at,null);
  assert.throws(()=>cleanLead({...fixture,website_status:'not_found'}),/проверка карточки/);
  assert.throws(()=>cleanLead({...fixture,website_status:'found',website:'https://vk.com/test',official_confirmed:true}),/Соцсеть/);
  assert.throws(()=>cleanLead({...fixture,website_status:'found',website:'https://example.org',official_confirmed:false}),/Подтвердите/);
});
test('negative site check needs both sources, date, city, and explanation; audit survives edits',()=>{
  const l=cleanLead({...fixture,website_status:'not_found',card_checked:true,web_checked:true,checked_at:new Date().toISOString(),reason:'Проверены карточка и поиск по названию с городом, сайт не найден.'});
  assert.equal(l.website_status,'not_found');assert.equal(l.verification_history.length,1);
  assert.throws(()=>cleanLead({...l,sources:[l.card_url]}),/источник независимого/);
  const updated=cleanLead({notes:'Новая заметка'},l);assert.equal(updated.verification_history.length,1);
  const rechecked=cleanLead({reason:'Проверено повторно: карточка и независимый поиск.'},updated);assert.equal(rechecked.verification_history.length,2);
  assert.equal(rechecked.verification_history[0].reason,l.reason);
});
test('deduplication normalizes name/address/phone and keeps distinct branches',()=>{
  assert.ok(sameCompany(fixture,{...fixture,card_url:'',card_id:'',name:fixture.name.toLowerCase()}));
  assert.ok(sameCompany({...fixture,address:''},{...fixture,phone:'8 000 000 00 01',card_url:'',address:''}));
  assert.equal(sameCompany({...fixture,card_url:''},{...fixture,card_url:'',address:'Тестовый адрес, 2'}),false);
  assert.equal(sameCompany({...fixture,card_id:'1'},{...fixture,card_id:'2'}),false);
});
test('CSV roundtrip supports BOM, quotes, semicolons and newlines; spreadsheet formulas inert',()=>{
  const l=cleanLead({...fixture,name:'=ТЕСТ',notes:'Строка; с "кавычками"\nещё строка'});
  const csv=toCsv([l]).toString('utf8');assert.ok(csv.startsWith('\uFEFF'));assert.match(csv,/"'=ТЕСТ"/);
  const rows=csvParse(csv);assert.equal(rows[0].notes,l.notes);assert.equal(rows[0].name,"'=ТЕСТ");
  assert.throws(()=>csvParse('name;notes\na;"unfinished'),/не закрыта/);
});
test('XLSX is a valid ZIP with XML workbook, inline strings, freeze pane and UTF-8 values',()=>{
  const bytes=toXlsx([cleanLead(fixture)]);const files={};let offset=0;
  while(bytes.readUInt32LE(offset)===0x04034b50){const size=bytes.readUInt32LE(offset+18),len=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28),name=bytes.subarray(offset+30,offset+30+len).toString('utf8'),start=offset+30+len+extra;files[name]=bytes.subarray(start,start+size).toString('utf8');offset=start+size;}
  assert.equal(bytes.readUInt32LE(offset),0x02014b50);assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);
  assert.match(files['xl/worksheets/sheet1.xml'],/ТЕСТОВАЯ КОМПАНИЯ/);assert.match(files['xl/worksheets/sheet1.xml'],/t="inlineStr"/);assert.match(files['xl/worksheets/sheet1.xml'],/state="frozen"/);assert.ok(files['[Content_Types].xml']);
});
test('source URLs reject executable protocols, credentials and secret query parameters',()=>{
  for(const url of ['javascript:alert(1)','https://user:password@example.org','https://example.org?key=abc'])assert.throws(()=>cleanLead({...fixture,sources:[url]}));
  assert.throws(()=>cleanLead({...fixture,card_url:'https://example.org/firm/1'}),/2ГИС/);
  assert.throws(()=>cleanLead({...fixture,card_url:'https://2gis.ru/search/test'}),/карточку компании/);
  const before=cleanLead(fixture),after=cleanLead({card_url:'https://2gis.ru/firm/10000000000000002'},before);
  assert.equal(after.card_id,'10000000000000002');
  assert.throws(()=>manualSearchPlan({city:'',categories:['Кафе']}));
  assert.throws(()=>manualSearchPlan({city:'Город',categories:['Кафе'],limit:10000}));
});
test('license and AI remote-data gates do not infer consent from an API key',()=>{
  assert.equal(publicConfig({DGIS_API_KEY:'unit-key'}).dgis_ready,false);
  assert.equal(publicConfig({DGIS_API_KEY:'unit-key',DGIS_STORAGE_LICENSE_CONFIRMED:'true'}).dgis_ready,true);
  assert.equal(publicConfig({AI_PROVIDER:'compatible',AI_MODEL:'test',AI_BASE_URL:'https://example.org/v1'}).ai_ready,false);
  assert.equal(publicConfig({AI_PROVIDER:'compatible',AI_MODEL:'test',AI_BASE_URL:'http://example.org/v1',AI_ALLOW_REMOTE:'true'}).ai_ready,false);
  assert.throws(()=>assertNoSecrets({instructions:'secret-unit-value'},{AI_API_KEY:'secret-unit-value'}),/Секреты/);
});
test('HTTP app persists leads, skips duplicates, filters and exports the same subset',async()=>{
  const {app,request,base,directory}=await launch();
  try{
    const root=await fetch(base+'/');assert.equal(root.status,200);assert.match(root.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    const created=await request('/api/leads','POST',fixture);assert.equal(created.status,201);
    const duplicate=await request('/api/leads','POST',{...fixture,notes:'Не должно заменить заметки'});assert.equal(duplicate.data.duplicate,true);assert.equal(duplicate.data.lead.notes,fixture.notes);
    const saved=await request('/api/leads/'+created.data.lead.id,'PUT',{notes:'Сохранённая заметка',lead_status:'Готов к звонку'});assert.equal(saved.status,200);
    const filters=await request('/api/leads?phone=true&lead_status='+encodeURIComponent('Готов к звонку'));assert.equal(filters.data.leads.length,1);
    assert.equal((await request('/api/leads?website_status=found')).data.leads.length,0);
    const exportRes=await fetch(base+'/api/export?website_status=found');const csv=await exportRes.text();assert.ok(!csv.includes(fixture.name));
    const xlsx=await fetch(base+'/api/export?format=xlsx');assert.equal(xlsx.status,200);assert.match(xlsx.headers.get('content-type'),/spreadsheet/);
    await app.close();
    const restart=createApp({directory,env:{AI_PROVIDER:'none'}});try{const l=restart.store.all('leads');assert.equal(l.length,1);assert.equal(l[0].notes,'Сохранённая заметка');}finally{restart.store.close();}
  }catch(e){await app.close().catch(()=>{});throw e;}
});
test('cross-origin writes and missing token are rejected; credentials never returned',async()=>{
  const {app,request,base}=await launch({AI_API_KEY:'private-unit-secret',DGIS_API_KEY:'private-dgis-unit-secret'});
  try{
    const r=await request('/api/leads','POST',fixture,{Origin:'https://untrusted.example'});assert.equal(r.status,403);
    const noToken=await fetch(base+'/api/leads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fixture)});assert.equal(noToken.status,403);
    const data=await (await fetch(base+'/api/state')).text();assert.equal(data.includes('private-unit-secret'),false);assert.equal(data.includes('private-dgis-unit-secret'),false);
    assert.equal((await request('/api/agents','POST',agent({instructions:'private-unit-secret'}))).status,400);
    assert.equal((await request('/api/search','POST',{city:'Самара',categories:['Кафе'],limit:10,mode:'api'})).status,400);
  }finally{await app.close();}
});
test('manual search produces source links and an auditable run without manufacturing leads',async()=>{
  const {app,request}=await launch();try{
    const r=await request('/api/search','POST',{city:'Тестовый город',categories:['Кафе'],limit:10,mode:'manual'});assert.equal(r.status,202);
    const run=await finished(request,r.data.id);assert.equal(run.status,'completed');assert.match(run.result.links[0].url,/https:\/\/2gis.ru\/search\//);assert.equal(app.store.all('leads').length,0);assert.ok(run.agent_snapshot.instructions);
  }finally{await app.close();}
});
test('agent lifecycle covers create/edit/copy/template/pause/resume/archive with history retained',async()=>{
  const {app,request}=await launch();try{
    const c=await request('/api/agents','POST',agent());const id=c.data.id;assert.equal(c.status,201);
    assert.equal((await request('/api/agents/'+id,'PUT',{name:'Новое имя'})).data.name,'Новое имя');
    const run=await request('/api/agents/'+id+'/run','POST',{input:'Проверяемые исходные данные'});assert.equal((await finished(request,run.data.id)).status,'completed');
    assert.equal((await request('/api/agents/'+id+'/pause','POST',{})).data.paused,true);
    assert.equal((await request('/api/agents/'+id+'/run','POST',{input:'a'})).status,400);
    await request('/api/agents/'+id+'/resume','POST',{});
    const copy=await request('/api/agents/'+id+'/copy','POST',{});assert.notEqual(copy.data.id,id);assert.deepEqual(copy.data.file_ids,[]);
    const template=await request('/api/agents/'+id+'/template','POST',{});assert.equal(template.status,201);assert.deepEqual(template.data.file_ids,[]);
    assert.equal((await request('/api/agents/'+id,'DELETE',{})).status,200);
    assert.ok(app.store.get('runs',run.data.id));assert.equal(app.store.get('agents',id).archived,true);
    assert.equal((await request('/api/agents/company-finder','DELETE',{})).status,400);
  }finally{await app.close();}
});
test('file and history permissions isolate agents and reject unauthorized input',async()=>{
  const {app,request}=await launch();try{
    const f1=(await request('/api/files','POST',{name:'allowed.txt',content:'Разрешённый материал'})).data;
    const f2=(await request('/api/files','POST',{name:'other.txt',content:'Чужой материал не должен попасть'})).data;
    const a=(await request('/api/agents','POST',agent({sources:['files'],tools:['read_files','create_report'],file_ids:[f1.id]}))).data;
    const invalid=await request('/api/agents/'+a.id+'/run','POST',{input:'Вход не разрешён'});assert.equal(invalid.status,400);
    const run=(await request('/api/agents/'+a.id+'/run','POST',{})).data;
    const done=await finished(request,run.id);assert.match(done.result.text,/Разрешённый материал/);assert.doesNotMatch(done.result.text,/Чужой материал/);assert.equal(done.sources_snapshot.length,1);
    const other=(await request('/api/agents','POST',agent({sources:['history'],tools:['read_history','create_report']}))).data;
    assert.equal((await request('/api/agents/'+other.id+'/run','POST',{})).status,400);
    assert.equal((await request('/api/files','POST',{name:'bad.exe',content:'test'})).status,400);
    assert.equal((await request('/api/files','POST',{name:'big.txt',content:'x'.repeat(500001)})).status,400);
  }finally{await app.close();}
});
test('import reports row-level failures and does not treat receipt time as verification',async()=>{
  const {app,request}=await launch();try{
    const rows=[fixture,{...fixture,name:'Строка без источника',card_url:'',sources:[]}];
    const r=await request('/api/leads/import','POST',{format:'json',text:JSON.stringify(rows),rights_confirmed:true});assert.equal(r.data.created,1);assert.equal(r.data.errors.length,1);
    const l=app.store.all('leads')[0];assert.equal(l.checked_at,null);assert.equal(l.website_status,'manual');assert.ok(l.observed_at);
    const again=await request('/api/leads/import','POST',{format:'json',text:JSON.stringify([fixture]),rights_confirmed:true});assert.equal(again.data.duplicates,1);
  }finally{await app.close();}
});
test('real model adapter receives only allowed materials; pause prevents accepting late output',async()=>{
  let captured,slow=false,requests=0;
  const model=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;captured=JSON.parse(body);requests++;if(slow)await new Promise(r=>setTimeout(r,200));if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({message:{content:'ТЕСТ: подтверждено материалом [S1]'}}));}});
  await new Promise(r=>model.listen(0,'127.0.0.1',r));
  const {app,request}=await launch({AI_PROVIDER:'ollama',AI_MODEL:'unit-model',AI_BASE_URL:'http://127.0.0.1:'+model.address().port});
  try{
    await request('/api/files','POST',{name:'not-allowed.txt',content:'Не передавать модели'});
    const a=(await request('/api/agents','POST',agent({mode:'ai',tools:['read_input','create_report','use_model']}))).data;
    const r=(await request('/api/agents/'+a.id+'/run','POST',{input:'Передать только этот текст'})).data;
    const done=await finished(request,r.id);assert.equal(done.status,'completed');assert.match(captured.messages[1].content,/Передать только этот текст/);assert.doesNotMatch(JSON.stringify(captured),/Не передавать модели/);assert.equal(captured.tools,undefined);assert.equal(captured.stream,false);
    slow=true;const pending=(await request('/api/agents/'+a.id+'/run','POST',{input:'slow'})).data;
    while(requests<2)await new Promise(r=>setTimeout(r,5));
    await request('/api/runs/'+pending.id+'/pause','POST',{});const paused=(await request('/api/runs/'+pending.id)).data;assert.equal(paused.status,'paused');assert.equal(paused.result,null);
  }finally{await app.close();await new Promise(r=>model.close(r));}
});

test('licensed catalog adapter uses official endpoints, city/district filters and preserves uncertainty',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url)=>{
    const u=new URL(url);calls.push(u);
    assert.equal(u.origin,'https://catalog.api.2gis.com');assert.equal(u.pathname,'/3.0/items');
    assert.equal(u.searchParams.get('key'),'test-only-not-real');
    const type=u.searchParams.get('type');
    const items=type==='adm_div.city'?[{id:'100',name:'Тестовый город',region_id:'10'}]:type==='adm_div.district'?[{id:'200',name:'Тестовый район'}]:[
      {id:'10000000000000011',name:'ТЕСТОВАЯ СЕТЬ',org:{branch_count:50},rubrics:[{name:'Кафе'}]},
      {id:'10000000000000012',name:'ТЕСТ — сайт-кандидат',address_name:'Тестовый адрес',rubrics:[{name:'Кафе'}],contact_groups:[{contacts:[{type:'website',url:'https://example.org/site'},{type:'phone',value:'+70000000000'}]}]},
      {id:'10000000000000013',name:'ТЕСТ — без контактного поля',rubrics:[{name:'Иная категория'}]}
    ];
    return new Response(JSON.stringify({meta:{code:200},result:{items,total:items.length}}),{status:200,headers:{'Content-Type':'application/json'}});
  });
  const out=await searchDgis({city:'Тестовый город',district:'Тестовый район',categories:['Кафе'],limit:10,exclude_chains:true},{DGIS_API_KEY:'test-only-not-real',DGIS_STORAGE_LICENSE_CONFIRMED:'true',DGIS_CONTACTS_ENABLED:'true',DGIS_REQUEST_INTERVAL_MS:'1000'},new AbortController().signal);
  assert.equal(calls.length,3);assert.equal(calls[2].searchParams.get('city_id'),'100');assert.equal(calls[2].searchParams.get('district_id'),'200');assert.match(calls[2].searchParams.get('fields'),/items.contact_groups/);
  assert.equal(out.skipped,1);assert.equal(out.leads.length,2);assert.ok(out.leads.every(l=>l.website_status==='manual'));assert.equal(out.leads[1].category_uncertain,true);
  assert.equal(cleanLead(out.leads[0]).checked_at,null);
});

test('compatible adapter uses bearer header, refuses malformed JSON, and never exposes the key',async t=>{
  let captured;
  t.mock.method(globalThis,'fetch',async(url,options)=>{captured={url:String(url),options};return new Response(JSON.stringify({choices:[{message:{content:'{"fact":"Тест [S1]"}'}}]}),{status:200});});
  const a=agent({output_format:'json'}),env={AI_PROVIDER:'compatible',AI_MODEL:'test',AI_BASE_URL:'http://127.0.0.1:9999/v1',AI_API_KEY:'unit-compatible-secret'};
  const out=await generateModel(a,[{id:'S1',content:'Тестовые данные'}],env,new AbortController().signal);
  assert.equal(captured.url,'http://127.0.0.1:9999/v1/chat/completions');assert.equal(captured.options.headers.Authorization,'Bearer unit-compatible-secret');assert.doesNotMatch(captured.options.body,/unit-compatible-secret/);assert.equal(JSON.parse(out.text).fact,'Тест [S1]');
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({choices:[{message:{content:'not json'}}]}),{status:200}));
  await assert.rejects(generateModel(a,[],env,new AbortController().signal),/невалидный JSON/);
});
