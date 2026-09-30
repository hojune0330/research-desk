const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { Parser } = require('htmlparser2');

function htmlText(html) {
  let ignored = 0, output = '';
  const excluded = new Set(['script','style','noscript','iframe','svg','template']);
  const blocks = new Set(['p','div','br','li','h1','h2','h3','h4','tr','section','article','header','footer']);
  const parser = new Parser({
    onopentag(name) { if (excluded.has(name)) ignored++; if (!ignored && blocks.has(name)) output += '\n'; },
    ontext(text) { if (!ignored) output += text; },
    onclosetag(name) { if (excluded.has(name)) ignored = Math.max(0, ignored - 1); if (!ignored && blocks.has(name)) output += '\n'; }
  }, { decodeEntities: true });
  parser.write(html); parser.end();
  return output.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}
function decode(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return new TextDecoder('euc-kr').decode(buffer); }
}
function checkDocxBudget(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('DOCX 파일 형식을 확인해 주세요.');
  const count = buffer.readUInt16LE(end + 10), offset = buffer.readUInt32LE(end + 16);
  if (count > 2500 || offset >= end) throw new Error('DOCX의 압축 구조가 너무 큽니다. 문서를 나누어 주세요.');
  let position = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || buffer.readUInt32LE(position) !== 0x02014b50) throw new Error('DOCX 파일 형식을 확인해 주세요.');
    const size = buffer.readUInt32LE(position + 24); total += size;
    if (size > 16 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error('DOCX의 추출 데이터가 너무 큽니다. 문서를 나누어 주세요.');
    position += 46 + buffer.readUInt16LE(position + 28) + buffer.readUInt16LE(position + 30) + buffer.readUInt16LE(position + 32);
  }
}
async function extract(buffer, extension) {
  if (extension === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, disableFontFace: true });
    const doc = await task.promise;
    try {
      if (doc.numPages > 1500) throw new Error('PDF는 1,500쪽까지 지원합니다.');
      const sections = []; let characters = 0;
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i), content = await page.getTextContent();
        const text = content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('');
        characters += text.length;
        if (characters > 2_000_000) throw new Error('추출 텍스트가 너무 큽니다. PDF를 나누어 주세요.');
        sections.push({ page: i, text }); page.cleanup();
      }
      return sections;
    } finally { await doc.destroy(); }
  }
  if (extension === '.docx') {
    checkDocxBudget(buffer);
    const mammoth = require('mammoth');
    const { value } = await mammoth.extractRawText({ buffer });
    if (value.length > 2_000_000) throw new Error('추출 텍스트가 너무 큽니다. 문서를 나누어 주세요.');
    return [{ text: value }];
  }
  const text = decode(buffer);
  return [{ text: ['.html','.htm'].includes(extension) ? htmlText(text) : text }];
}
if (parentPort) {
  (async () => {
    const buffer = workerData.file ? await fs.readFile(workerData.file) : Buffer.from(workerData.buffer);
    const sections = await extract(buffer, workerData.extension);
    if (sections.reduce((sum, section) => sum + section.text.length, 0) > 2_000_000) throw new Error('추출 텍스트가 너무 큽니다.');
    parentPort.postMessage({ sections });
  })().catch(error => parentPort.postMessage({ error: /너무|지원|나누어/.test(error.message) ? error.message : '텍스트를 추출하지 못했습니다. 암호화·손상·스캔 파일인지 확인해 주세요.' }));
}
module.exports = { htmlText, decode, extract };
