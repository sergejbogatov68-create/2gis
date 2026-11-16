import { randomUUID } from 'node:crypto';

export const LEAD_STATUSES = ['Новый', 'Проверить', 'Готов к звонку', 'Позвонил', 'Заинтересован', 'Отказ', 'Перезвонить'];
export const SITE_STATUSES = { manual: 'Нужно проверить вручную', found: 'Сайт найден', not_found: 'Сайт не найден при проверке' };
export const SOURCE_TYPES = ['input', 'files', 'history', 'leads', 'catalog'];
export const TOOLS = ['read_input', 'read_files', 'read_history', 'read_leads', 'catalog_search', 'create_report', 'use_model'];
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function must(condition, message, status = 400) { if (!condition) throw new AppError(message, status); }
export function str(value, max = 2000) { return String(value ?? '').trim().slice(0, max); }
export function normalize(value) { return str(value).toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, ''); }
export function phoneKey(value) {
  const p = String(value ?? '').replace(/\D/g, '');
  return p.length === 11 && p[0] === '8' ? '7' + p.slice(1) : p;
}
export function httpUrl(value) {
  const s = str(value, 2000);
  if (!s) return '';
  try {
    const u = new URL(s);
    must(['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !/[\r\n]/.test(s), 'Нужна полная ссылка http:// или https:// без пароля.');
    for (const k of u.searchParams.keys()) must(!/^(key|api[_-]?key|token|access_token|secret|password)$/i.test(k), 'В источнике не должно быть секретных ключей или токенов.');
    return u.href;
  } catch (e) { throw e instanceof AppError ? e : new AppError('Некорректная ссылка. Укажите полный адрес https://…'); }
}
export function isSocialOrDirectory(value) {
  try {
    const h = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    return ['vk.com','vk.ru','t.me','telegram.me','instagram.com','facebook.com','ok.ru','2gis.ru','2gis.com','yandex.ru','ya.ru','google.com','avito.ru','zoon.ru','yell.ru','taplink.cc','wa.me'].some(x => h === x || h.endsWith('.' + x));
  } catch { return false; }
}
export function cleanLead(input, existing = {}, clock = () => new Date().toISOString()) {
  const now = clock();
  const d = { ...existing, ...input };
  const lead = {
    id: existing.id || randomUUID(), name: str(d.name, 300), category: str(d.category, 300),
    description: str(d.description), city: str(d.city, 200), district: str(d.district, 200),
    address: str(d.address, 500), phone: str(d.phone, 100), card_id: str(d.card_id, 100),
    card_url: httpUrl(d.card_url), website: httpUrl(d.website),
    website_status: d.website_status || 'manual', lead_status: d.lead_status || 'Новый',
    review_status: d.review_status || 'unreviewed', notes: str(d.notes, 10000),
    reason: str(d.reason, 4000), sources: [], checked_at: d.checked_at || null,
    card_checked: d.card_checked === true, web_checked: d.web_checked === true,
    official_confirmed: d.official_confirmed === true, chain: d.chain === true,
    chain_reason: str(d.chain_reason, 1000), category_uncertain: d.category_uncertain === true,
    origin: existing.origin || str(d.origin || 'manual', 40),
    observed_at: existing.observed_at || now, created_at: existing.created_at || now,
    updated_at: now, verification_history: existing.verification_history || []
  };
  must(lead.name, 'Укажите название компании.');
  must(Object.hasOwn(SITE_STATUSES, lead.website_status), 'Неизвестный статус сайта.');
  must(LEAD_STATUSES.includes(lead.lead_status), 'Неизвестный статус лида.');
  must(['unreviewed', 'verified', 'unsuitable'].includes(lead.review_status), 'Неизвестная отметка проверки.');
  if (lead.card_url) {
    const u = new URL(lead.card_url);
    must(/(^|\.)2gis\.(ru|com|kz|kg|uz|ae)$/.test(u.hostname), 'В поле 2ГИС нужна ссылка на карточку 2ГИС.');
    const fromUrl=u.pathname.match(/\/firm\/(\d+)(?:\/|$)/)?.[1];
    must(fromUrl,'Укажите ссылку на карточку компании 2ГИС с /firm/ID, а не на общую страницу поиска.');
    lead.card_id=fromUrl;
  }
  must(Array.isArray(d.sources || []), 'Источники должны быть списком ссылок.');
  lead.sources = [...new Set([...(d.sources || []).map(httpUrl), lead.card_url].filter(Boolean))].slice(0, 30);
  must(lead.sources.length > 0, 'Добавьте хотя бы одну ссылку на источник данных.');
  if (lead.checked_at) {
    const timestamp = Date.parse(lead.checked_at);
    must(Number.isFinite(timestamp) && timestamp <= Date.parse(now) + 60000, 'Дата проверки некорректна или находится в будущем.');
    lead.checked_at = new Date(timestamp).toISOString();
  }
  if (lead.website_status === 'found') {
    must(lead.website && lead.official_confirmed && !isSocialOrDirectory(lead.website), 'Подтвердите официальный сайт. Соцсеть или каталог требуют ручной проверки.');
    must(lead.reason && lead.checked_at, 'Для найденного сайта нужны обоснование и дата проверки.');
    lead.sources = [...new Set([...lead.sources, lead.website])];
  }
  if (lead.website_status === 'not_found') {
    must(!lead.website, 'Если найден адрес сайта, сначала выясните, принадлежит ли он компании.');
    must(lead.card_url && lead.card_checked && lead.web_checked && lead.checked_at && lead.reason.length >= 10, 'Для статуса «Сайт не найден при проверке» нужны проверка карточки и поиска по названию с городом, дата и обоснование.');
    must(lead.city && lead.sources.some(u => u !== lead.card_url && !/(^|\.)2gis\./.test(new URL(u).hostname)), 'Добавьте город и источник независимого поиска, кроме карточки 2ГИС.');
  }
  if (lead.review_status === 'verified') must(lead.checked_at && lead.reason, 'Для отметки «Проверено» нужны дата проверки и обоснование.');
  if (lead.lead_status === 'Готов к звонку') must(lead.phone && lead.review_status !== 'unsuitable', 'Для звонка нужен публичный телефон и подходящая компания.');
  const snapshot = { website_status: lead.website_status, website: lead.website, reason: lead.reason, sources: lead.sources, checked_at: lead.checked_at, card_checked: lead.card_checked, web_checked: lead.web_checked, official_confirmed: lead.official_confirmed };
  const previous = lead.verification_history.at(-1);
  if (lead.checked_at && JSON.stringify(previous && { ...previous, saved_at: undefined }) !== JSON.stringify(snapshot)) {
    lead.verification_history = [...lead.verification_history, { ...snapshot, saved_at: now }].slice(-100);
  }
  return lead;
}
export function sameCompany(a, b) {
  if (a.card_id && b.card_id) return a.card_id === b.card_id;
  if (a.card_url && a.card_url === b.card_url) return true;
  if (!normalize(a.name) || normalize(a.name) !== normalize(b.name)) return false;
  if (a.city && b.city && normalize(a.city) !== normalize(b.city)) return false;
  if (a.address && b.address) return normalize(a.address) === normalize(b.address);
  return phoneKey(a.phone).length >= 7 && phoneKey(a.phone) === phoneKey(b.phone);
}
export function priority(lead) {
  // A transparent order, not an invented business score.
  if (lead.review_status === 'unsuitable') return 0;
  if (lead.phone && lead.website_status === 'not_found') return 3;
  if (lead.phone && lead.website_status === 'manual') return 2;
  return 1;
}
export function filterLeads(leads, query = {}) {
  const q = str(query.q).toLocaleLowerCase('ru');
  const items = leads.filter(l => (!q || [l.name,l.city,l.category,l.address,l.phone,l.notes].join(' ').toLocaleLowerCase('ru').includes(q))
    && (!query.website_status || l.website_status === query.website_status)
    && (!query.lead_status || l.lead_status === query.lead_status)
    && (!query.review_status || l.review_status === query.review_status)
    && (!query.city || normalize(l.city) === normalize(query.city))
    && (!query.category || l.category.toLocaleLowerCase('ru').includes(str(query.category).toLocaleLowerCase('ru')))
    && (query.phone !== 'true' || Boolean(l.phone))
    && (query.exclude_chains !== 'true' || !l.chain));
  return items.sort((a,b) => query.sort === 'name' ? a.name.localeCompare(b.name, 'ru') : query.sort === 'recent' ? b.updated_at.localeCompare(a.updated_at) : priority(b)-priority(a) || b.updated_at.localeCompare(a.updated_at));
}
export function cleanAgent(input, existing = {}) {
  const d = { ...existing, ...input };
  const array = (x, allow) => [...new Set((Array.isArray(x) ? x : []).filter(v => allow.includes(v)))];
  const a = {
    id: existing.id || randomUUID(), name: str(d.name, 120), goal: str(d.goal, 1500),
    instructions: str(d.instructions, 10000), expected_result: str(d.expected_result, 2000),
    input_hint: str(d.input_hint, 1000), output_format: ['markdown','json','text'].includes(d.output_format) ? d.output_format : 'markdown',
    kind: existing.kind || (d.kind === 'leads' ? 'leads' : 'custom'),
    mode: d.mode === 'local' ? 'local' : 'ai',
    sources: array(d.sources, SOURCE_TYPES), tools: array(d.tools, TOOLS),
    file_ids: [...new Set((Array.isArray(d.file_ids) ? d.file_ids : []).map(x => str(x, 100)))].slice(0,10),
    paused: d.paused === true, archived: existing.archived === true,
    color: ['green','blue','orange','purple'].includes(d.color) ? d.color : 'green',
    created_at: existing.created_at || new Date().toISOString(), updated_at: new Date().toISOString()
  };
  must(a.name && a.goal, 'Укажите название и цель агента.');
  if (a.kind !== 'leads') must(!a.tools.includes('catalog_search') && !a.sources.includes('catalog'), 'В MVP поиск 2ГИС доступен встроенному агенту компаний.');
  return a;
}
export function csvParse(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/,1)[0];
  const delim = (first.match(/;/g)||[]).length > (first.match(/,/g)||[]).length ? ';' : ',';
  const rows = []; let row = [], field = '', quoted = false;
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (c==='"') {
      if (quoted && text[i+1]==='"') { field+='"'; i++; } else quoted=!quoted;
    } else if (c===delim && !quoted) { row.push(field); field=''; }
    else if ((c==='\n'||c==='\r') && !quoted) { if(c==='\r'&&text[i+1]==='\n')i++; row.push(field); if(row.some(Boolean))rows.push(row); row=[]; field=''; }
    else field+=c;
  }
  must(!quoted, 'В CSV не закрыта кавычка.');
  row.push(field); if(row.some(Boolean))rows.push(row);
  must(rows.length >= 2, 'CSV должен содержать заголовки и хотя бы одну компанию.');
  const aliases = { 'название':'name','название компании':'name','категория':'category','описание':'description','город':'city','район':'district','адрес':'address','телефон':'phone','2гис':'card_url','карточка 2гис':'card_url','сайт':'website','источники':'sources','заметки':'notes','статус лида':'lead_status','дата проверки':'checked_at','обоснование':'reason' };
  const headers=rows.shift().map(h=>aliases[h.trim().toLowerCase()]||h.trim());
  must(headers.includes('name'), 'В CSV нужна колонка name или «Название».');
  return rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??''])));
}
export function manualSearchPlan(params) {
  const city=str(params.city,200), district=str(params.district,200);
  const categories=(Array.isArray(params.categories)?params.categories:[]).map(x=>str(x,150)).filter(Boolean).slice(0,8);
  const queries=(Array.isArray(params.queries)?params.queries:[]).map(x=>str(x,200)).filter(Boolean).slice(0,8);
  must(city && (categories.length || queries.length), 'Укажите город и хотя бы одну категорию или поисковый запрос.');
  const limit=Number(params.limit??30);
  must(Number.isInteger(limit)&&limit>=1&&limit<=100,'Количество результатов: от 1 до 100.');
  return { city,district,categories,queries,limit,exclude_chains:params.exclude_chains!==false,
    links:[...new Set([...categories,...queries])].map(q=>({query:[q,city,district].filter(Boolean).join(' '),url:'https://2gis.ru/search/'+encodeURIComponent([q,city,district].filter(Boolean).join(' '))})) };
}
