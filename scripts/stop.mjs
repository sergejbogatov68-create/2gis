import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopRunning } from '../src/launcher.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
try {
  const result=await stopRunning(root);
  console.log(result.stopped?'Контур остановлен. Данные сохранены.':'Контур уже остановлен.');
}catch(error){console.error(error.message||'Не удалось остановить приложение.');process.exitCode=1;}
