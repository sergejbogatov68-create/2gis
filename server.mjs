import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { openStore, seed } from './src/store.mjs';
import { AppError, must, str, cleanLead, cleanAgent, sameCompany, filterLeads, csvParse, manualSearchPlan, SITE_STATUSES, LEAD_STATUSES } from './src/domain.mjs';
import { publicConfig, assertNoSecrets, redact, searchDgis, generateModel } from './src/integrations.mjs';
import { toCsv, toXlsx } from './src/export.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ID=createHash('sha256').update(ROOT.replaceAll('\\','/').toLowerCase()).digest('hex').slice(0,16);
if(existsSync(join(ROOT,'.env'))){for(const [k,v] of Object.entries(parseEnv(readFileSync(join(ROOT,'.env'),'utf8'))))if(process.env[k]===undefined)process.env[k]=v;}

export function createApp({directory=resolve(ROOT,process.env.DATA_DIR||'data'),env=process.env}={}) {
  const store=openStore(directory);seed(store);
  const token=randomBytes(32).toString('hex');
  const active=new Map();
  const now=()=>new Date().toISOString();
  const getAgent=id=>{const a=store.get('agents',id);must(a&&!a.archived,'Агент не найден.',404);return a;};
  const getLead=id=>{const l=store.get('leads',id);must(l,'Компания не найдена.',404);return l;};
  function saveNewLead(raw) {
    const candidate=cleanLead(raw);
    const duplicate=store.all('leads').find(l=>sameCompany(l,candidate));
    if(duplicate)return {duplicate:true,lead:duplicate};
    store.put('leads',candidate);return {duplicate:false,lead:candidate};
  }
  function requirePermission(agent,source,tool){must(agent.sources.includes(source)&&agent.tools.includes(tool),`У агента нет разрешения «${source} / ${tool}». Измените источники и действия в его настройках.`);}
  function materialsFor(agent,input) {
    const materials=[];let left=45000;
    const add=(title,content,urls=[])=>{if(left<=0)return;let s=str(content,45000);const truncated=s.length>left;if(truncated)s=s.slice(0,left)+'\n[Материал сокращён до лимита контекста]';materials.push({id:'S'+(materials.length+1),title,content:s,urls,truncated});left-=s.length;};
    if(str(input,20000)){requirePermission(agent,'input','read_input');add('Входные данные пользователя',str(input,20000));}
    if(agent.sources.includes('files')){
      requirePermission(agent,'files','read_files');
      for(const id of agent.file_ids){const f=store.get('files',id);must(f,'Подключённый файл не найден.');add('Файл: '+f.name,f.content);}
    }
    if(agent.sources.includes('history')){
      requirePermission(agent,'history','read_history');
      for(const r of store.all('runs').filter(r=>r.agent_id===agent.id&&r.status==='completed').slice(-3))add('Собственная история: '+r.started_at,str(r.result?.text,6000));
    }
    if(agent.sources.includes('leads')){
      requirePermission(agent,'leads','read_leads');
      for(const l of filterLeads(store.all('leads')).slice(0,100))add('Сохранённая компания: '+l.name,JSON.stringify({name:l.name,category:l.category,city:l.city,address:l.address,phone:l.phone,website:l.website,website_status:SITE_STATUSES[l.website_status],reason:l.reason,checked_at:l.checked_at,notes:l.notes}),l.sources);
    }
    must(materials.length,'Нет входных данных. Введите текст или явно подключите файлы, свою историю либо базу компаний.');
    return materials;
  }
  function queueRun(agent,payload) {
    must(!agent.paused,'Агент приостановлен. Сначала возобновите его.');
    must(![...active.values()].some(a=>a.agentId===agent.id),'У этого агента уже есть активный запуск.',409);
    must(active.size<3,'Одновременно можно запустить не больше трёх агентов.',409);
    assertNoSecrets(payload,env);
    must(agent.tools.includes('create_report'),'Разрешите агенту создание результата.');
    let materials,plan;
    if(agent.kind==='leads'){
      requirePermission(agent,'input','read_input');requirePermission(agent,'catalog','catalog_search');
      plan=manualSearchPlan(payload);
      if(payload.mode==='api'){
        const cfg=publicConfig(env);must(cfg.dgis_ready,'Автопоиск пока недоступен. Нужны DGIS_API_KEY и разрешение на хранение и экспорт (DGIS_STORAGE_LICENSE_CONFIRMED). Ручной режим уже работает.');
      }
    }else{
      materials=materialsFor(agent,payload.input);
      if(agent.mode==='ai'){
        must(agent.tools.includes('use_model'),'У агента нет разрешения на обращение к ИИ-модели.');
        must(publicConfig(env).ai_ready,'ИИ-модель не подключена. Откройте «Настройки» или выберите режим «Сбор материалов без ИИ» в агенте.');
      }
    }
    const run={id:randomUUID(),agent_id:agent.id,agent_name:agent.name,agent_snapshot:agent,status:'running',started_at:now(),finished_at:null,
      input_snapshot:agent.kind==='leads'?plan:{input:str(payload.input,20000)},sources_snapshot:materials||[],result:null,error:null};
    store.put('runs',run);
    const controller=new AbortController();let finish;
    const done=new Promise(resolve=>{finish=resolve;});
    active.set(run.id,{controller,agentId:agent.id,done});
    setImmediate(async()=>{
      try{
        let result;
        if(agent.kind==='leads'){
          if(payload.mode==='api'){
            const found=await searchDgis(payload,env,controller.signal);controller.signal.throwIfAborted();
            let created=0,duplicates=0;
            store.transaction(()=>{for(const l of found.leads){const r=saveNewLead(l);r.duplicate?duplicates++:created++;}});
            result={text:`Поиск через официальный API 2ГИС завершён.\n\nДобавлено компаний: ${created}.\nДубликатов пропущено: ${duplicates}.\nКрупных сетей пропущено: ${found.skipped}.\nЗапросов API: ${found.requests}.\n\n${found.warnings.join('\n')}\n\nПроверка наличия сайта в интернете не выполнялась. Все карточки требуют ручной проверки.`,created,duplicates,warnings:found.warnings,plan,mode:'api'};
          }else{
            result={text:'План ручного поиска\n\n'+plan.links.map(l=>l.query+'\n'+l.url).join('\n\n')+`\n\nНужно собрать до ${plan.limit} компаний. Откройте поиск, проверьте условия использования данных и добавляйте только те сведения, которые вправе хранить. Внесите название, категорию, город, адрес, публичный телефон и ссылку на источник. Не переносите данные массово.\n\nПроверьте карточку, затем выполните отдельный поиск по названию с городом. Сохраните ссылки, дату и результат. До этого оставьте «Нужно проверить вручную».`,links:plan.links,plan,mode:'manual'};
          }
        }else if(agent.mode==='local'){
          result={text:'Сбор материалов без ИИ\n\nЭто локальная подборка входных данных, без анализа моделью и без проверки содержимого ссылок.\n\nЗадача: '+agent.goal+'\nОжидаемый результат после анализа: '+agent.expected_result+'\n\n'+materials.map(m=>`[${m.id}] ${m.title}\n${m.content}\n${m.urls.join('\n')}`).join('\n\n'),mode:'local',warning:'ИИ не использовался. Для анализа подключите модель и измените режим агента.'};
          if(agent.output_format==='json')result.text=JSON.stringify({mode:'local',goal:agent.goal,materials,warning:result.warning},null,2);
        }else{
          result=await generateModel(agent,materials,env,controller.signal);
        }
        controller.signal.throwIfAborted();
        const latest=store.get('runs',run.id);
        if(latest.status==='running')store.put('runs',{...latest,status:'completed',finished_at:now(),result:JSON.parse(redact(result,env))});
      }catch(e){
        const latest=store.get('runs',run.id);
        if(latest?.status==='running')store.put('runs',{...latest,status:controller.signal.aborted?'paused':'failed',finished_at:now(),error:e instanceof AppError?redact(e.message,env):controller.signal.aborted?'Запуск приостановлен. Запрос к источнику отменён.':'Запуск не выполнен. Проверьте настройки источника и повторите.'});
      }finally{active.delete(run.id);finish();}
    });
    return run;
  }
  function pauseRun(id) {
    const run=store.get('runs',id);must(run,'Запуск не найден.',404);
    if(run.status==='running'){
      store.put('runs',{...run,status:'paused',finished_at:now(),error:'Приостановлено пользователем. Для продолжения создайте новый запуск.'});
      active.get(id)?.controller.abort();
    }
    return store.get('runs',id);
  }
  function output(res,status,data,type='application/json; charset=utf-8',headers={}){
    res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...headers});
    res.end(Buffer.isBuffer(data)?data:type.startsWith('application/json')?JSON.stringify(data):data);
  }
  async function body(req) {
    must((req.headers['content-type']||'').startsWith('application/json'),'Нужен запрос JSON.',415);
    let size=0;const parts=[];
    for await(const chunk of req){size+=chunk.length;must(size<=2_000_000,'Слишком большой запрос. Лимит — 2 МБ.',413);parts.push(chunk);}
    try{return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');}catch{throw new AppError('Не удалось прочитать JSON запроса.');}
  }
  const server=http.createServer(async(req,res)=>{
    try{
      const host=req.headers.host||'';
      must(/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host),'Приложение доступно только локально.',403);
      const url=new URL(req.url,'http://'+host);const p=url.pathname;
      const origin=req.headers.origin;
      if(p.startsWith('/api/')){
        must(!origin||origin==='http://'+host,'Запрос с другого сайта отклонён.',403);
        must(req.headers['sec-fetch-site']!=='cross-site','Запрос с другого сайта отклонён.',403);
        if(!['GET','HEAD'].includes(req.method)){
          const supplied=Buffer.from(req.headers['x-local-token']||'');const expected=Buffer.from(token);
          must(supplied.length===expected.length&&timingSafeEqual(supplied,expected),'Обновите страницу приложения и повторите.',403);
        }
        const q=Object.fromEntries(url.searchParams);
        if(req.method==='GET'&&p==='/api/health')return output(res,200,{app:'kontur-local-workspace',version:'1.0.0',status:'ok',workspace_id:WORKSPACE_ID,pid:process.pid});
        if(req.method==='GET'&&p==='/api/state')return output(res,200,{
          token,config:publicConfig(env),agents:store.all('agents').filter(a=>!a.archived),templates:store.all('templates').filter(t=>!t.archived),
          leads:store.all('leads'),runs:store.all('runs').reverse().map(({sources_snapshot,input_snapshot,agent_snapshot,result,...r})=>({...r,preview:str(result?.text,250),mode:result?.mode})),
          files:store.all('files').map(({content,...f})=>f),preferences:store.get('preferences','search')||null,
          statuses:LEAD_STATUSES,site_statuses:SITE_STATUSES
        });
        if(req.method==='GET'&&p==='/api/leads')return output(res,200,{leads:filterLeads(store.all('leads'),q)});
        if(req.method==='GET'&&p==='/api/export'){
          const leads=filterLeads(store.all('leads'),q);const xlsx=q.format==='xlsx';
          return output(res,200,xlsx?toXlsx(leads):toCsv(leads),xlsx?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv; charset=utf-8',{'Content-Disposition':`attachment; filename="kontur-leads-${now().slice(0,10)}.${xlsx?'xlsx':'csv'}"`});
        }
        if(req.method==='GET'&&p==='/api/import-template'){
          const sample='\uFEFFname;category;city;address;phone;card_url;website;sources;notes\r\n';
          return output(res,200,sample,'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="companies-template.csv"'});
        }
        if(req.method==='POST'&&p==='/api/leads'){
          const data=await body(req);assertNoSecrets(data,env);const result=saveNewLead(data);return output(res,result.duplicate?200:201,result);
        }
        if(req.method==='POST'&&p==='/api/leads/import'){
          const data=await body(req);assertNoSecrets(data,env);
          must(data.rights_confirmed===true,'Импортируйте только данные, которые вы вправе хранить и использовать.');
          let rows;
          if(data.format==='json'){try{rows=JSON.parse(data.text);}catch{throw new AppError('Файл JSON повреждён.');}must(Array.isArray(rows),'JSON должен содержать массив компаний.');}
          else rows=csvParse(data.text);
          must(rows.length<=1000,'За один импорт можно добавить до 1000 строк.');
          let created=0,duplicates=0;const errors=[];
          store.transaction(()=>{rows.forEach((row,i)=>{
            try{
              must(row&&typeof row==='object'&&!Array.isArray(row),'Строка должна содержать объект компании.');
              const raw={...row,origin:'import'};
              if(typeof raw.sources==='string')raw.sources=raw.sources.split(/[\n|]/).map(s=>s.trim()).filter(Boolean);
              for(const k of ['card_checked','web_checked','official_confirmed','chain','category_uncertain'])if(typeof raw[k]==='string')raw[k]=['true','да','1'].includes(raw[k].toLowerCase());
              const r=saveNewLead(raw);r.duplicate?duplicates++:created++;
            }catch(e){errors.push({row:i+(data.format==='json'?1:2),message:e instanceof AppError?e.message:'Не удалось прочитать строку.'});}
          });});
          return output(res,200,{created,duplicates,errors});
        }
        const leadMatch=p.match(/^\/api\/leads\/([^/]+)$/);
        if(leadMatch&&req.method==='PUT'){
          const data=await body(req);assertNoSecrets(data,env);const old=getLead(leadMatch[1]);
          const candidate=cleanLead(data,old);must(!store.all('leads').some(l=>l.id!==old.id&&sameCompany(l,candidate)),'Такая компания уже есть в базе. Проверьте название, адрес и карточку.',409);
          return output(res,200,store.put('leads',candidate));
        }
        if(req.method==='POST'&&p==='/api/search'){
          const data=await body(req);const plan=manualSearchPlan(data);store.put('preferences',{...plan,id:'search',mode:data.mode==='api'?'api':'manual'});
          return output(res,202,queueRun(getAgent('company-finder'),data));
        }
        if(req.method==='POST'&&p==='/api/agents'){
          const data=await body(req);assertNoSecrets(data,env);const a=cleanAgent(data);
          must(a.kind==='custom','Создайте обычного агента или скопируйте встроенного.');
          for(const id of a.file_ids)must(store.get('files',id),'Выбранный файл не найден.');
          return output(res,201,store.put('agents',a));
        }
        const am=p.match(/^\/api\/agents\/([^/]+)(?:\/(copy|pause|resume|run|template))?$/);
        if(am){const a=getAgent(am[1]),action=am[2];
          if(req.method==='PUT'&&!action){const d=await body(req);assertNoSecrets(d,env);const c=cleanAgent(d,a);for(const id of c.file_ids)must(store.get('files',id),'Выбранный файл не найден.');return output(res,200,store.put('agents',c));}
          if(req.method==='DELETE'&&!action){must(a.id!=='company-finder','Встроенного агента можно приостановить; удалить можно его копии.');for(const [id,job]of active)if(job.agentId===a.id)pauseRun(id);store.put('agents',{...a,archived:true,paused:true,updated_at:now()});return output(res,200,{archived:true,message:'Агент удалён из списка. История сохранена локально.'});}
          if(req.method==='POST'&&action==='copy'){return output(res,201,store.put('agents',{...a,id:randomUUID(),name:a.name+' — копия',paused:false,archived:false,file_ids:[],sources:a.sources.filter(s=>s!=='history'&&s!=='files'),tools:a.tools.filter(t=>t!=='read_history'&&t!=='read_files'),created_at:now(),updated_at:now()}));}
          if(req.method==='POST'&&['pause','resume'].includes(action)){if(action==='pause')for(const [id,job]of active)if(job.agentId===a.id)pauseRun(id);return output(res,200,store.put('agents',{...a,paused:action==='pause',updated_at:now()}));}
          if(req.method==='POST'&&action==='run')return output(res,202,queueRun(a,await body(req)));
          if(req.method==='POST'&&action==='template'){const t={...a,id:randomUUID(),kind:'custom',file_ids:[],sources:a.sources.filter(s=>!['files','history','catalog'].includes(s)),tools:a.tools.filter(t=>!['read_files','read_history','catalog_search'].includes(t)),archived:false,name:a.name+' — шаблон',created_at:now()};return output(res,201,store.put('templates',t));}
        }
        if(req.method==='POST'&&p==='/api/templates'){
          const data=await body(req);assertNoSecrets(data,env);const t=cleanAgent(data);t.kind='custom';t.file_ids=[];return output(res,201,store.put('templates',t));
        }
        const tm=p.match(/^\/api\/templates\/([^/]+)$/);
        if(tm&&req.method==='PUT'){const t=store.get('templates',tm[1]);must(t,'Шаблон не найден.',404);const d=await body(req);assertNoSecrets(d,env);const c=cleanAgent(d,t);c.file_ids=[];return output(res,200,store.put('templates',c));}
        const rm=p.match(/^\/api\/runs\/([^/]+)(?:\/(pause))?$/);
        if(rm){if(req.method==='POST'&&rm[2]==='pause')return output(res,200,pauseRun(rm[1]));if(req.method==='GET'&&!rm[2]){const r=store.get('runs',rm[1]);must(r,'Запуск не найден.',404);return output(res,200,r);}}
        if(req.method==='POST'&&p==='/api/files'){
          const data=await body(req);assertNoSecrets(data,env);const name=str(data.name,200).replace(/[\\/]/g,'_');
          must(/\.(txt|md|csv|json)$/i.test(name),'Поддерживаются TXT, MD, CSV и JSON в UTF-8.');
          must(typeof data.content==='string'&&Buffer.byteLength(data.content,'utf8')<=500000,'Файл должен быть текстовым, не больше 500 КБ.');
          must(!data.content.includes('\u0000'),'Это не текстовый файл UTF-8.');
          const f={id:randomUUID(),name,content:data.content,bytes:Buffer.byteLength(data.content,'utf8'),created_at:now()};store.put('files',f);const {content,...meta}=f;return output(res,201,meta);
        }
        if(req.method==='POST'&&p==='/api/model/check'){
          const cfg=publicConfig(env);must(cfg.ai_ready,'Сначала настройте модель в .env и перезапустите приложение.');
          const test={name:'Проверка подключения',goal:'Проверить соединение',instructions:'Ответь одним словом: Подключено.',expected_result:'Подключено',output_format:'text'};
          const result=await generateModel(test,[{id:'S1',title:'Тест',content:'Проверка подключения модели'}],env,AbortSignal.timeout(30000));
          return output(res,200,{connected:true,provider:result.provider,model:result.model});
        }
        throw new AppError('Такого действия нет.',404);
      }
      must(req.method==='GET'||req.method==='HEAD','Метод не поддерживается.',405);
      const assets={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};
      must(assets[p],'Страница не найдена.',404);
      const mime=p.endsWith('.js')?'text/javascript; charset=utf-8':p.endsWith('.css')?'text/css; charset=utf-8':p.endsWith('.svg')?'image/svg+xml':'text/html; charset=utf-8';
      const headers={'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'Permissions-Policy':'microphone=(), camera=(), geolocation=()'};
      return output(res,200,req.method==='HEAD'?'':readFileSync(join(ROOT,'public',assets[p])),mime,headers);
    }catch(e){if(!res.headersSent)output(res,e instanceof AppError?e.status:500,{error:e instanceof AppError?redact(e.message,env):'Не удалось выполнить действие. Проверьте данные и повторите.'});else res.end();}
  });
  return {server,store,close:async()=>{const jobs=[...active.values()].map(j=>j.done);for(const [id]of active)pauseRun(id);await Promise.allSettled(jobs);await new Promise(r=>server.close(r));store.close();}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const app=createApp();const port=Number(process.env.PORT)||4317;
  app.server.listen(port,'127.0.0.1',()=>console.log(`\nКонтур — локальная студия агентов\nhttp://127.0.0.1:${port}\nДанные: ${resolve(ROOT,process.env.DATA_DIR||'data')}\nОстановка: Ctrl+C\n`));
  app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`Порт ${port} занят. Откройте работающий экземпляр или измените PORT в .env.`:'Не удалось запустить локальный сервер.');process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
}
