import { SITE_STATUSES } from './domain.mjs';
const columns = [
  ['name','Название'],['category','Категория'],['description','Описание'],['city','Город'],['district','Район'],['address','Адрес'],['phone','Телефон'],
  ['card_id','ID 2ГИС'],['card_url','Карточка 2ГИС'],['website','Сайт'],['website_status','Проверка сайта'],['reason','Обоснование'],['sources','Источники'],
  ['checked_at','Дата проверки'],['observed_at','Дата добавления источника'],['lead_status','Статус лида'],['review_status','Проверено'],['chain','Сеть'],['chain_reason','Признаки сети'],['category_uncertain','Категория требует проверки'],['notes','Заметки']
];
function value(l,k){const v=l[k]; if(k==='website_status')return SITE_STATUSES[v]; if(k==='review_status')return {verified:'Проверен',unsuitable:'Неподходящий',unreviewed:'Не проверен'}[v]; return Array.isArray(v)?v.join('\n'):typeof v==='boolean'?(v?'Да':'Нет'):String(v??'');}
function safeCell(x) { return /^[\s]*[=+\-@\t\r]/.test(x) ? "'" + x : x; }
export function toCsv(leads) {
  const rows=[columns.map(c=>c[1]),...leads.map(l=>columns.map(([k])=>value(l,k)))];
  return Buffer.from('\uFEFF'+rows.map(r=>r.map(s=>'"'+safeCell(s).replaceAll('"','""')+'"').join(';')).join('\r\n'),'utf8');
}
function xml(s) { return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
function crc32(buf) { let c=0xffffffff; for(const b of buf){c^=b;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0; }
// Uncompressed ZIP, valid OOXML. Inline strings never execute spreadsheet formulas.
function zip(files) {
  const parts=[],directory=[];let offset=0;
  for(const [name,body] of files){const n=Buffer.from(name),b=Buffer.from(body),crc=crc32(b);const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc,14);h.writeUInt32LE(b.length,18);h.writeUInt32LE(b.length,22);h.writeUInt16LE(n.length,26);parts.push(h,n,b);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(b.length,20);c.writeUInt32LE(b.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);directory.push(c,n);offset+=h.length+n.length+b.length;}
  const dir=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...parts,dir,end]);
}
function letter(i){let s='';do{s=String.fromCharCode(65+i%26)+s;i=Math.floor(i/26)-1;}while(i>=0);return s;}
export function toXlsx(leads) {
  const rows=[columns.map(c=>c[1]),...leads.map(l=>columns.map(([k])=>value(l,k)))];
  const sheet='<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>'+columns.map((_,i)=>`<col min="${i+1}" max="${i+1}" width="26" customWidth="1"/>`).join('')+'</cols><sheetData>'+rows.map((r,i)=>`<row r="${i+1}">`+r.map((s,j)=>`<c r="${letter(j)}${i+1}" t="inlineStr"><is><t xml:space="preserve">${xml(s)}</t></is></c>`).join('')+'</row>').join('')+`</sheetData><autoFilter ref="A1:${letter(columns.length-1)}${rows.length}"/></worksheet>`;
  return zip([
    ['[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml','<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Компании" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml',sheet]
  ]);
}
