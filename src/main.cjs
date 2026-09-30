const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { Library } = require('./library.cjs');
const { collectPublicPage, publicUrl } = require('./public-url.cjs');
const { DEFAULT_MODEL, DECISIONS_STATUS, requestOpenAI, groundedChat, webSearch } = require('./openai.cjs');
app.setPath('userData', path.join(app.getPath('appData'), 'jev-research-desk'));
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
const root = app.getPath('userData'), entryUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const extensions = new Set(['.txt','.md','.csv','.html','.htm','.pdf','.docx']);
const defaults = { aiEnabled: false, consent: false, importPolicy: 'local_only', model: DEFAULT_MODEL };
let window, library, settings, keyCache, activeJob = null, lastSearch = null;
function assert(value, message) { if (!value) throw new Error(message); }
function text(value, max, name) { assert(typeof value === 'string' && value.length <= max && value.trim(), name + '을 확인해 주세요.'); return value.trim(); }
function notify(channel, value) { if (window && !window.isDestroyed()) window.webContents.send(channel, value); }
function handle(channel, work) {
  ipcMain.handle(channel, async (event, ...args) => {
    assert(window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === entryUrl, '허용되지 않은 창의 요청입니다.');
    try { return await work(...args); }
    catch (error) { throw new Error(error instanceof Error && !/SQLITE|ENOENT|EACCES|EPERM|file:|\\Users\\|Bearer|sk-/i.test(error.message) ? error.message : '작업을 완료하지 못했습니다. 파일과 접근 권한을 확인해 주세요.'); }
  });
}
async function writeAtomic(file, value) { const temp = file + '.pending'; await fs.writeFile(temp, value); await fs.rename(temp, file); }
async function readKey() {
  if (keyCache !== undefined) return keyCache;
  let data; try { data = await fs.readFile(path.join(root, 'openai-key.bin')); } catch (error) { if (error.code === 'ENOENT') return keyCache = ''; throw new Error('암호화된 키를 읽지 못했습니다.'); }
  assert(await safeStorage.isAsyncEncryptionAvailable(), 'Windows 계정 암호화를 사용할 수 없습니다.');
  const decrypted = await safeStorage.decryptStringAsync(data); keyCache = decrypted.result;
  if (decrypted.shouldReEncrypt) await writeAtomic(path.join(root, 'openai-key.bin'), await safeStorage.encryptStringAsync(keyCache)); return keyCache;
}
async function status() {
  let keyConfigured = false, keyError = null; try { keyConfigured = Boolean(await readKey()); } catch (error) { keyError = error.message; }
  return { settings, keyConfigured, keyError, encryptionAvailable: await safeStorage.isAsyncEncryptionAvailable(), decisions: DECISIONS_STATUS, version: app.getVersion(), count: library.count() };
}
const saveSettings = () => writeAtomic(path.join(root, 'settings.json'), JSON.stringify(settings));
function abortJob() { activeJob?.controller.abort(); }
async function job(kind, id, work) {
  assert(!activeJob, '현재 작업을 마치거나 중지한 뒤 다시 실행해 주세요.');
  const current = { id: text(id, 80, '작업 ID'), kind, controller: new AbortController() }; activeJob = current;
  try { return await work(current.controller.signal, current.id); }
  finally { if (activeJob === current) activeJob = null; notify('activity', { id: current.id, finished: true }); }
}
function extract(data, signal) {
  return new Promise((resolve, reject) => {
    const workerFile = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'extractor.cjs') : path.join(__dirname, 'extractor.cjs');
    const worker = new Worker(workerFile, { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 192 } }); let settled = false;
    const done = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); worker.terminate(); error ? reject(error) : resolve(value); };
    const cancel = () => done(new Error('작업을 중지했습니다.'));
    const timer = setTimeout(() => done(new Error('추출 시간이 초과되었습니다. 파일을 나누어 주세요.')), 45_000);
    worker.once('message', value => done(value.error ? new Error(value.error) : null, value.sections)); worker.once('error', () => done(new Error('텍스트 추출에 실패했습니다. 파일 형식을 확인해 주세요.')));
    worker.once('exit', () => { if (!settled) done(new Error('추출 작업이 끝나지 못했습니다.')); });
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  });
}
async function importFiles(paths, signal, id) {
  assert(Array.isArray(paths) && paths.length <= 1000 && paths.every(file => typeof file === 'string' && file.length < 4096), '자료 경로를 확인해 주세요.');
  const files = [], outcomes = [], seen = new Set(); let bytes = 0, capped = false;
  async function walk(file, depth = 0) {
    if (signal.aborted) return;
    if (depth > 12 || files.length + outcomes.length >= 1000) { capped = true; return; }
    const resolved = path.resolve(file); if (seen.has(resolved)) return; seen.add(resolved);
    let stat; try { stat = await fs.lstat(resolved); } catch { outcomes.push({ title: path.basename(file), ok: false, error: '파일을 읽을 수 없습니다.' }); return; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      let children; try { children = await fs.readdir(resolved, { withFileTypes: true }); } catch { outcomes.push({ title: path.basename(file), ok: false, error: '폴더를 읽을 수 없습니다.' }); return; }
      for (const item of children) { if (item.name.startsWith('.') || ['node_modules','dist','portable-build','$RECYCLE.BIN','System Volume Information'].includes(item.name)) continue; await walk(path.join(resolved, item.name), depth + 1); } return;
    }
    if (!stat.isFile() || !extensions.has(path.extname(file).toLowerCase())) return;
    if (stat.size > 25 * 1024 * 1024 || bytes + stat.size > 500 * 1024 * 1024) { outcomes.push({ title: path.basename(file), ok: false, error: '파일당 25MB, 한 번에 총 500MB까지 지원합니다.' }); return; }
    bytes += stat.size; files.push(resolved);
  }
  for (const file of paths) await walk(file);
  for (let i = 0; i < files.length && !signal.aborted; i++) {
    const file = files[i], title = path.basename(file), extension = path.extname(file).toLowerCase(); notify('activity', { id, detail: (i + 1) + '/' + files.length + ' · ' + title });
    try { const buffer = await fs.readFile(file); assert(buffer.length <= 25 * 1024 * 1024, '파일 크기가 변경되어 한도를 넘었습니다.');
      const sections = await extract({ buffer, extension }, signal); if (signal.aborted) break;
      outcomes.push({ ...(await library.add({ title, kind: 'file', origin: title, buffer, extension, sections, policy: settings.importPolicy })), ok: true });
    } catch (error) { if (!signal.aborted) outcomes.push({ title, ok: false, error: /지원|텍스트|추출|크기/.test(error.message) ? error.message : '추가하지 못했습니다.' }); }
    await new Promise(resolve => setImmediate(resolve));
  }
  lastSearch = null; notify('library:changed', {}); return { outcomes, cancelled: signal.aborted, capped };
}
const locationText = location => location.kind === 'page' ? location.page + '쪽' : location.kind === 'lines' ? '추출문 ' + location.start + '–' + location.end + '행' : '추출문';
async function runSearch(values, signal, id) {
  const query = text(values?.query, 2400, '검색어'), revision = library.revision;
  let local = library.search(query);
  if (!local.length && /그중|그 중|이중|이 중|이것|그것|위의|앞의|더 자세|더 알려|왜 그런|^왜[?？\s]*$|^(요약|정리|비교)해\s?줘/.test(query)) {
    const prior = library.history(1).find(turn => !turn.invalidated);
    if (prior) local = library.search(prior.query);
  }
  const result = { query, local, decisions: DECISIONS_STATUS, answer: null, refs: [], sent: [], web: null, usage: [], warnings: [] }; notify('search:local', { id, ...result }); lastSearch = result;
  if (!settings.aiEnabled) { if (values.includeWeb) result.warnings.push('웹 검색은 설정에서 AI를 켜면 사용할 수 있습니다.'); return result; }
  assert(settings.consent, '외부 전송 안내를 확인해 주세요.'); const key = await readKey(); assert(key, '로컬 검색은 완료했습니다. AI 답변은 OpenAI 키가 필요합니다.'); let web = null;
  if (values.includeWeb === true) {
    notify('activity', { id, detail: '입력한 검색어로 공개 웹을 검색합니다. 로컬 문서 내용은 보내지 않습니다.' });
    try { web = await webSearch(key, settings.model, query, signal); result.web = web; result.usage.push(web.usage); } catch (error) { if (signal.aborted) throw error; result.warnings.push(error.message); }
  }
  if (signal.aborted || revision !== library.revision) throw new Error('자료나 전송 설정이 변경되어 작업을 중지했습니다.');
  const allowed = library.eligible(local), history = library.history(6).filter(turn => !turn.invalidated && turn.sent.every(ref => { const source = library.source(ref.sourceId); return source && source.policy === 'ai_allowed' && source.revision === ref.sourceRevision && source.policy_revision === ref.policyRevision; }));
  if (allowed.length) {
    notify('activity', { id, detail: '허용된 자료의 발췌문으로 GPT 답변을 작성합니다.' });
    try { const answer = await groundedChat(key, settings.model, query, allowed, history, web, signal); result.answer = answer.answer; result.refs = answer.refs; result.sent = answer.sent; result.usage.push(answer.usage); }
    catch (error) { if (signal.aborted) throw error; result.warnings.push(error.message); }
  } else if (web) result.answer = web.summary;
  else result.warnings.push(local.length ? '찾은 자료가 로컬 전용입니다. 자료함에서 AI 전송을 허용하면 근거를 사용해 답변할 수 있습니다.' : '검색 근거가 없습니다. 자료를 추가하거나 웹 포함을 켜 주세요.');
  if (signal.aborted || revision !== library.revision) throw new Error('자료나 전송 설정이 변경되어 답변을 반영하지 않았습니다.');
  if (result.answer) library.saveTurn({ query, answer: result.answer, refs: result.refs, sent: result.sent, web: web ? web.citations : [], usage: result.usage }); lastSearch = result; return result;
}
function createWindow() {
  window = new BrowserWindow({ width: 1260, height: 900, minWidth: 780, minHeight: 600, title: 'Research Desk', backgroundColor: '#f4f5f1', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); window.webContents.session.setPermissionCheckHandler(() => false);
  window.loadFile(path.join(__dirname, 'index.html')); window.on('closed', () => { abortJob(); window = null; });
}
app.whenReady().then(async () => {
  app.setAppUserModelId('ai.jevresearchdesk.desktop'); library = await new Library(path.join(root, 'library')).open();
  try { const saved = JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8')); settings = { ...defaults, aiEnabled: saved.aiEnabled === true, consent: saved.consent === true, importPolicy: saved.importPolicy === 'ai_allowed' && saved.consent === true ? 'ai_allowed' : 'local_only', model: typeof saved.model === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(saved.model) ? saved.model : DEFAULT_MODEL }; }
  catch (error) { settings = { ...defaults }; if (error.code !== 'ENOENT') dialog.showErrorBox('설정 복구', '저장된 설정을 읽지 못해 AI를 끄고 로컬 검색으로 시작합니다.'); }
  handle('app:status', status);
  handle('settings:save', async values => {
    assert(values && typeof values === 'object', '설정을 확인해 주세요.'); const model = text(values.model, 100, '모델 이름'); assert(/^[a-zA-Z0-9._-]+$/.test(model), '모델 이름을 확인해 주세요.'); assert(values.aiEnabled !== true || values.consent === true, 'AI 외부 전송 안내를 확인해 주세요.'); abortJob();
    if (typeof values.key === 'string' && values.key.trim()) { const key = text(values.key, 1000, 'API 키'); assert(!/[\s\x00-\x1f]/.test(key), '키에 공백이 포함되어 있습니다.'); assert(await safeStorage.isAsyncEncryptionAvailable(), 'Windows 계정 암호화를 사용할 수 없어 키를 저장하지 않았습니다.'); await writeAtomic(path.join(root, 'openai-key.bin'), await safeStorage.encryptStringAsync(key)); keyCache = key; }
    settings = { aiEnabled: values.aiEnabled === true, consent: values.consent === true, importPolicy: values.importPolicy === 'ai_allowed' && values.consent === true ? 'ai_allowed' : 'local_only', model }; await saveSettings(); return status();
  });
  handle('key:clear', async () => { abortJob(); await fs.rm(path.join(root, 'openai-key.bin'), { force: true }); keyCache = ''; settings.aiEnabled = false; await saveSettings(); return status(); });
  handle('key:check', async () => { assert(!activeJob, '현재 작업을 마친 뒤 연결을 확인해 주세요.'); const response = await requestOpenAI(await readKey(), 'models/' + encodeURIComponent(settings.model), null, null, 'GET'); return { model: response.id, message: '키와 모델 접근을 확인했습니다. 실제 GPT 생성·Decisions 권한 확인은 별도입니다.' }; });
  handle('library:list', () => library.list());
  handle('files:pick', async (kind, id) => { assert(['files','folder'].includes(kind), '자료 선택을 확인해 주세요.'); assert(!activeJob, '현재 작업을 마친 뒤 추가해 주세요.');
    const selected = await dialog.showOpenDialog(window, { title: '자료 추가', properties: kind === 'folder' ? ['openDirectory'] : ['openFile','multiSelections'], filters: [{ name: '자료', extensions: ['txt','md','csv','html','htm','pdf','docx'] }] }); if (selected.canceled) return { outcomes: [], cancelled: true }; return job('import', id, (signal, jobId) => importFiles(selected.filePaths, signal, jobId)); });
  handle('files:drop', (paths, id) => job('import', id, (signal, jobId) => importFiles(paths, signal, jobId)));
  handle('material:add', (values, id) => job('import', id, async signal => {
    assert(['url','paste'].includes(values?.kind), '자료 형식을 확인해 주세요.'); const title = text(values.title || '붙여넣은 자료', 300, '제목'); let result;
    if (values.kind === 'paste') result = await library.add({ title, kind: 'paste', origin: title, sections: [{ text: text(values.text, 2_000_000, '자료 내용') }], policy: settings.importPolicy });
    else { const page = await collectPublicPage(text(values.url, 3000, '웹 주소'), signal), sections = await extract({ buffer: page.buffer, extension: page.extension }, signal); if (signal.aborted) throw new Error('작업을 중지했습니다.'); result = await library.add({ title: values.title?.trim() ? title : new URL(page.url).hostname, kind: 'url', origin: page.url, sections, policy: settings.importPolicy }); }
    lastSearch = null; notify('library:changed', {}); return { outcomes: [{ ...result, ok: true }] };
  }));
  handle('source:policy', (id, policy) => { text(id, 100, '자료 ID'); assert(policy !== 'ai_allowed' || settings.consent, '설정에서 외부 전송 안내를 먼저 확인해 주세요.'); abortJob(); library.setPolicy(id, policy); lastSearch = null; return library.list(); });
  handle('source:remove', async id => { const source = library.source(text(id, 100, '자료 ID')); assert(source, '자료가 없습니다.'); const choice = await dialog.showMessageBox(window, { type: 'question', buttons: ['취소','자료 삭제'], defaultId: 0, cancelId: 0, message: '자료함에서 삭제할까요?', detail: source.title + '\n앱의 사본과 색인을 삭제합니다. 가져오기 전 원본은 그대로 있습니다.' }); if (choice.response !== 1) return { removed: false }; abortJob(); await library.remove(id); lastSearch = null; return { removed: true }; });
  handle('source:view', (id, chunkId) => {
    const source = library.source(text(id, 100, '자료 ID')); assert(source, '자료가 없습니다.');
    const focused = chunkId ? library.db.prepare('SELECT text,location FROM chunks WHERE source_id=? AND id=?').get(id, text(chunkId, 150, '발췌문 ID')) : null;
    const sections = focused ? [focused] : library.db.prepare('SELECT text,location FROM chunks WHERE source_id=? ORDER BY rowid LIMIT 100').all(id);
    return { title: source.title, focused: Boolean(focused), text: sections.map(section => '[' + locationText(JSON.parse(section.location)) + ']\n' + section.text).join('\n\n'), truncated: !focused && library.db.prepare('SELECT count(*) AS n FROM chunks WHERE source_id=?').get(id).n > 100 };
  });
  handle('source:open', async id => { const source = library.source(text(id, 100, '자료 ID')); assert(source, '자료가 없습니다.'); if (source.kind === 'url') await shell.openExternal(publicUrl(source.origin).toString()); else if (source.original) { const error = await shell.openPath(source.original); assert(!error, '원문을 여는 프로그램을 찾지 못했습니다.'); } else return { usePreview: true }; return { opened: true }; });
  handle('link:open', async value => { await shell.openExternal(publicUrl(text(value, 3000, '출처 주소')).toString()); return { opened: true }; });
  handle('search:run', (values, id) => job('search', id, (signal, jobId) => runSearch(values, signal, jobId)));
  handle('job:cancel', () => { abortJob(); return { cancelled: true }; }); handle('history:list', () => library.history());
  handle('history:clear', async () => { const choice = await dialog.showMessageBox(window, { type: 'question', buttons: ['취소','대화 삭제'], defaultId: 0, cancelId: 0, message: '저장된 대화를 모두 삭제할까요?' }); if (choice.response === 1) { abortJob(); library.clearHistory(); lastSearch = null; } return { cleared: choice.response === 1 }; });
  handle('report:save', async () => {
    assert(lastSearch, '먼저 검색해 주세요.'); const result = lastSearch, destination = await dialog.showSaveDialog(window, { defaultPath: 'research-' + new Date().toISOString().slice(0,10) + '.md', filters: [{ name: 'Markdown', extensions: ['md'] }] }); if (destination.canceled) return { saved: false };
    const lines = ['# Research Desk 결과','', '검색: ' + result.query,'', '정렬: 로컬 키워드 검색. Decisions 평가는 미연결.','']; if (result.answer) lines.push('## GPT 답변','',result.answer,'');
    for (const item of result.local) { const source = library.source(item.sourceId); if (!source) continue; lines.push('## ' + item.title, '', locationText(item.location) + ' · ' + (source.policy === 'ai_allowed' ? 'AI 전송 허용' : '로컬 전용'), '', item.text, ''); if (item.publicUrl) lines.push('출처: ' + item.publicUrl,''); }
    if (result.web) { lines.push('## 웹 검색 요약','',result.web.summary,''); result.web.citations.forEach(item => lines.push('- ' + item.title + ': ' + item.url)); }
    lines.push('', 'AI 결과는 제공된 근거에 대한 답변이며 사실 확정을 뜻하지 않습니다.'); await fs.writeFile(destination.filePath, lines.join('\n'), 'utf8'); return { saved: true };
  });
  createWindow();
}).catch(() => { dialog.showErrorBox('Research Desk 시작 실패', '로컬 자료함을 열지 못했습니다. 다른 실행 중인 앱과 저장 폴더 접근 권한을 확인해 주세요. 기존 자료를 덮어쓰지 않았습니다.'); app.quit(); });
app.on('window-all-closed', () => app.quit()); app.on('before-quit', () => { abortJob(); library?.close(); });
