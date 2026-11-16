import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRunning } from '../src/launcher.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
try {
  const result=await ensureRunning(root,{browser:!process.argv.includes('--no-browser')});
  console.log(process.argv.includes('--json')?JSON.stringify(result):'Контур открыт: '+result.url);
} catch(error) {
  console.error(error.message||'Не удалось открыть приложение.');
  process.exitCode=1;
}
