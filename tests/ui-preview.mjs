// Isolated manual UI verification. Uses no production data or external services.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server.mjs';
const app=createApp({directory:mkdtempSync(join(tmpdir(),'kontur-ui-')),env:{AI_PROVIDER:'none'}});
app.server.listen(4318,'127.0.0.1',()=>console.log('Isolated UI check: http://127.0.0.1:4318'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
