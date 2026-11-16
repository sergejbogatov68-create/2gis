import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { launchSettings, workspaceId, ensureRunning, stopRunning } from '../src/launcher.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function reserve(){const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
test('launcher reads the configured port without overriding process variables',()=>{
  const directory=mkdtempSync(join(tmpdir(),'kontur-launch-config-'));
  writeFileSync(join(directory,'.env'),'PORT=4328\nAI_API_KEY=test-only-not-real\n');
  assert.equal(launchSettings(directory,{}).url,'http://127.0.0.1:4328');
  assert.equal(launchSettings(directory,{PORT:'4330'}).port,4330);
  assert.throws(()=>launchSettings(directory,{PORT:'4328 & bad'}),/PORT/);
  assert.equal(workspaceId(directory).length,16);
});
test('desktop launch starts the local app once and reuses its process on repeat',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'kontur-launch-run-')),port=await reserve();
  const environment={...process.env,PORT:String(port),DATA_DIR:directory,AI_PROVIDER:'none'};
  let pid;
  try{
    const first=await ensureRunning(root,{environment,browser:false});pid=first.pid;
    assert.equal(first.reused,false);assert.ok(pid>0);
    const second=await ensureRunning(root,{environment,browser:false});
    assert.equal(second.reused,true);assert.equal(second.pid,first.pid);
    const health=await(await fetch(first.url+'/api/health')).json();
    assert.equal(health.app,'kontur-local-workspace');assert.equal(health.workspace_id,workspaceId(root));assert.equal(health.token,undefined);assert.equal(health.config,undefined);
    const stopped=await stopRunning(root,{environment});pid=null;assert.equal(stopped.stopped,true);
    assert.equal((await stopRunning(root,{environment})).stopped,false);
  }finally{if(pid)process.kill(pid);}
});
test('launcher refuses an occupied port and does not replace another application',async()=>{
  const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({app:'another-app'}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    await assert.rejects(ensureRunning(root,{environment:{PORT:String(server.address().port)},browser:false}),/занят другим приложением/);
    assert.equal(server.listening,true);
  }finally{await new Promise(r=>server.close(r));}
});
