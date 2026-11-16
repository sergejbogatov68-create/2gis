import { existsSync, readFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';

export function workspaceId(root) {
  return createHash('sha256').update(resolve(root).replaceAll('\\','/').toLowerCase()).digest('hex').slice(0,16);
}
export function launchSettings(root, environment=process.env) {
  const env={...environment};
  const file=join(root,'.env');
  if(existsSync(file))for(const [key,value] of Object.entries(parseEnv(readFileSync(file,'utf8'))))if(env[key]===undefined)env[key]=value;
  const port=env.PORT===undefined?4317:Number(env.PORT);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT в .env должен быть целым числом от 1 до 65535.');
  return {root:resolve(root),env,port,url:'http://127.0.0.1:'+port,workspace:workspaceId(root)};
}
async function inspect(settings) {
  let response;
  try {response=await fetch(settings.url+'/api/health',{signal:AbortSignal.timeout(1000),redirect:'error'});}
  catch {return null;}
  let data;
  try {data=await response.json();} catch {throw new Error(`Порт ${settings.port} занят другим приложением. Измените PORT в .env.`);}
  if(!response.ok||data.app!=='kontur-local-workspace'||data.workspace_id!==settings.workspace)
    throw new Error(`Порт ${settings.port} занят другим приложением или другой копией Контура. Закройте её либо измените PORT в .env.`);
  return data;
}
export function openBrowser(url) {
  // The URL is generated solely from a validated numeric port, never user text.
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(url))throw new Error('Некорректный локальный адрес.');
  if(process.platform!=='win32')throw new Error('Ярлык предназначен для Windows. Откройте '+url+' в браузере самостоятельно.');
  const browser=spawn(process.env.ComSpec||'cmd.exe',['/d','/c','start',url],{windowsHide:true,detached:true,stdio:'ignore'});
  return new Promise((resolve,reject)=>{browser.once('error',reject);browser.once('spawn',()=>{browser.unref();resolve();});});
}
export async function ensureRunning(root,{environment=process.env,browser=true}={}) {
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('Нужен Node.js версии 24 или новее.');
  const settings=launchSettings(root,environment);
  const current=await inspect(settings);
  if(current){if(browser)await openBrowser(settings.url);return {url:settings.url,pid:current.pid,reused:true};}
  const dataDir=resolve(settings.root,settings.env.DATA_DIR||'data');
  mkdirSync(dataDir,{recursive:true});
  const output=openSync(join(dataDir,'server.log'),'a');
  let failure;
  try{
    const child=spawn(process.execPath,[join(settings.root,'server.mjs')],{cwd:settings.root,env:settings.env,windowsHide:true,detached:true,stdio:['ignore',output,output]});
    child.once('error',error=>{failure=error;});child.unref();
  }finally{closeSync(output);}
  for(let attempt=0;attempt<30;attempt++){
    if(failure)throw new Error('Не удалось запустить Node.js. Проверьте установку и права на папку приложения.');
    await wait(300);
    const ready=await inspect(settings);
    if(ready){if(browser)await openBrowser(settings.url);return {url:settings.url,pid:ready.pid,reused:false};}
  }
  throw new Error('Сервер не запустился. Откройте data/server.log в папке приложения. Файл может находиться в DATA_DIR, если он задан.');
}

export async function stopRunning(root,{environment=process.env}={}) {
  const settings=launchSettings(root,environment),current=await inspect(settings);
  if(!current)return {stopped:false};
  if(!Number.isInteger(current.pid)||current.pid<1||current.pid===process.pid)throw new Error('Сервер не вернул допустимый идентификатор процесса. Остановка отменена.');
  process.kill(current.pid,'SIGTERM');
  for(let attempt=0;attempt<20;attempt++){await wait(100);if(!await inspect(settings))return {stopped:true};}
  throw new Error('Сервер ещё завершает работу. Подождите и повторите остановку.');
}
