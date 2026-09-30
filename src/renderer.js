const api = window.researchDesk;
const $ = id => document.getElementById(id);
let status, sources = [], materialKind = 'paste', currentJob = null, uiRevision = 0;
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function message(error) { return String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
function notice(value) { $('notice').textContent = value; $('notice').hidden = !value; }
function locationLabel(location) { return location?.kind === 'page' ? location.page + '쪽' : location?.kind === 'lines' ? '추출문 ' + location.start + '–' + location.end + '행' : '추출문'; }
function button(label, action, className = 'quiet') { const node = el('button', className, label); node.type = 'button'; node.addEventListener('click', () => Promise.resolve().then(action).catch(error => notice(message(error)))); return node; }
function busy(value) {
  $('searchButton').disabled = value; $('addButton').disabled = value; $('cancelButton').hidden = !value;
  $('searchButton').textContent = value ? '진행 중…' : '검색 ↗';
  $('query').setAttribute('aria-busy', String(value));
}
async function runTask(label, work) {
  if (currentJob) { notice('현재 작업을 마치거나 중지해 주세요.'); return; }
  const id = crypto.randomUUID(); currentJob = id; busy(true); notice(''); $('activity').textContent = label;
  try { return await work(id); }
  catch (error) { notice(message(error)); }
  finally { if (currentJob === id) { currentJob = null; busy(false); $('activity').textContent = ''; } }
}
function resetResults() { uiRevision++; $('results').hidden = true; $('resultList').replaceChildren(); }
function refreshMode() {
  const ai = status?.settings.aiEnabled && status?.keyConfigured;
  $('connection').textContent = ai ? 'GPT 설정됨 · 로컬 자료함' : '로컬 검색';
  $('modeNote').textContent = status?.settings.aiEnabled ? '질문·허용 발췌문을 OpenAI로 전송' : '로컬 검색 · 외부 전송 없음';
  $('importPolicyNote').textContent = status?.settings.importPolicy === 'ai_allowed' ? '새 자료는 AI 전송 허용으로 추가됩니다.' : '새 자료는 로컬 전용으로 추가됩니다.';
}
async function refresh() { status = await api.status(); sources = await api.list(); renderSources(); refreshMode(); }
function renderSources() {
  $('sourceCount').textContent = sources.length; $('sourceList').replaceChildren();
  const filter = $('libraryFilter').value.toLowerCase();
  const visible = sources.filter(source => source.title.toLowerCase().includes(filter));
  if (!visible.length) {
    const empty = el('div', 'library-empty'); empty.append(el('strong', '', sources.length ? '이름이 일치하는 자료가 없습니다.' : '아직 자료가 없습니다.'), el('p', '', '파일·폴더·링크·메모를 추가해 주세요.')); $('sourceList').append(empty);
  }
  for (const source of visible) {
    const row = el('article', 'source-row');
    const title = button(source.title, () => preview(source.id), 'source-title'); title.title = source.title; row.append(title);
    const meta = el('div', 'source-meta'); meta.append(el('span', '', source.kind === 'url' ? '웹 자료' : source.kind === 'paste' ? '메모' : source.title.split('.').pop().toUpperCase()), el('span', '', source.characters.toLocaleString() + '자'));
    if (source.aliases.length) meta.append(el('span', '', '중복 출처 ' + source.aliases.length)); row.append(meta);
    const controls = el('div', 'source-controls');
    const policy = button(source.policy === 'ai_allowed' ? 'AI 전송 허용' : '로컬 전용', async () => {
      if (source.policy !== 'ai_allowed' && !status.settings.consent) { await openSettings(); $('settingsMessage').textContent = '전송 안내를 확인하고 저장한 뒤 자료의 AI 전송을 허용해 주세요.'; return; }
      await api.setPolicy(source.id, source.policy === 'ai_allowed' ? 'local_only' : 'ai_allowed'); resetResults(); await refresh(); await renderHistory();
    }, source.policy === 'ai_allowed' ? 'policy allowed' : 'policy');
    controls.append(policy, button('삭제', async () => { const result = await api.remove(source.id); if (result.removed) { resetResults(); await refresh(); await renderHistory(); } }, 'delete-source'));
    row.append(controls); $('sourceList').append(row);
  }
}
async function preview(id, chunkId) {
  const result = await api.view(id, chunkId); $('previewTitle').textContent = result.title; $('previewText').textContent = result.text;
  $('previewNotice').textContent = result.focused ? '선택한 인용의 발췌문입니다. 위치와 문맥을 확인해 주세요.' : result.truncated ? '미리보기는 첫 100개 발췌문입니다. 원문에서 전체 자료를 확인해 주세요.' : '자료함에서 추출한 텍스트입니다. 줄 번호는 추출문 기준입니다.';
  if (!$('previewDialog').open) $('previewDialog').showModal();
}
function appendAnswerText(container, text, refs, web) {
  const local = new Map(refs.map(ref => [ref.citationId, ref])), urls = new Set((web || []).map(ref => ref.url));
  const pattern = /\[(L\d+)\]|\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    container.append(document.createTextNode(text.slice(last, match.index)));
    if (match[1] && local.has(match[1])) { const ref = local.get(match[1]); container.append(button('[' + match[1] + ']', () => preview(ref.sourceId, ref.chunkId), 'inline-citation')); }
    else if (match[3] && urls.has(match[3])) container.append(button(match[2], () => api.openLink(match[3]), 'inline-citation'));
    else container.append(document.createTextNode(match[0]));
    last = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(last)));
}
function answerCard(turn) {
  const card = el('article', 'answer-card'); card.append(el('div', 'user-question', turn.query));
  if (turn.invalidated) { card.append(el('p', 'muted', '이 답변은 출처 삭제 또는 전송 설정 변경으로 이후 AI 대화에서 제외되었습니다.')); return card; }
  card.append(el('div', 'answer-label', 'GPT 답변 · 출처에서 근거를 확인하세요'));
  const body = el('div', 'answer-body'); appendAnswerText(body, turn.answer, turn.refs || [], turn.web || []); card.append(body);
  const citations = el('div', 'citations');
  for (const ref of turn.refs || []) citations.append(button('[' + ref.citationId + '] ' + ref.title + ' · ' + locationLabel(ref.location), () => preview(ref.sourceId, ref.chunkId), 'citation'));
  for (const ref of turn.web || []) citations.append(button('웹 · ' + ref.title, () => api.openLink(ref.url), 'citation'));
  if (citations.childNodes.length) card.append(citations);
  if (turn.sent?.length) {
    const details = el('details', 'sent-details'); details.append(el('summary', '', '이번에 보낸 발췌문 ' + turn.sent.length + '개'));
    for (const item of turn.sent) details.append(el('strong', '', item.title + ' · ' + locationLabel(item.location)), el('p', '', item.text || '이 자료는 삭제되었습니다.'));
    card.append(details);
  }
  if (turn.usage?.length) { const usage = turn.usage.map(item => (item.kind === 'web_search' ? '웹 검색' : 'GPT') + ' 입력 ' + (item.inputTokens ?? '미확인') + ' / 출력 ' + (item.outputTokens ?? '미확인') + ' 토큰').join(' · '); card.append(el('p', 'usage', usage + ' · 청구 비용 미확인')); }
  return card;
}
async function renderHistory() {
  const history = await api.history(); $('conversation').replaceChildren(); history.forEach(turn => $('conversation').append(answerCard(turn)));
  $('intro').hidden = history.length > 0;
}
function renderResults(result) {
  $('results').hidden = false; $('intro').hidden = true; $('resultList').replaceChildren(); $('resultCount').textContent = result.local.length + '개 발췌문';
  $('rankingNote').textContent = '로컬 키워드 순서 · Decisions 연결 준비 중';
  if (!result.local.length) $('resultList').append(el('p', 'empty-result', '자료함에서 일치하는 발췌문을 찾지 못했습니다. 다른 표현이나 자료를 추가해 보세요.'));
  for (const item of result.local) {
    const card = el('article', 'result-card'); const heading = el('div', 'result-heading');
    heading.append(el('span', 'result-number', String(item.baseRank).padStart(2, '0')), button(item.title, () => preview(item.sourceId, item.chunkId), 'result-title')); card.append(heading);
    card.append(el('p', 'result-meta', locationLabel(item.location) + ' · ' + (item.policy === 'ai_allowed' ? 'AI 전송 허용' : '로컬 전용')));
    const excerpt = el('p', 'excerpt', item.text); card.append(excerpt);
    const controls = el('div', 'result-controls');
    if (item.kind !== 'paste') controls.append(button('원문 열기 ↗', async () => { const result = await api.open(item.sourceId); if (result.usePreview) await preview(item.sourceId); })); card.append(controls); $('resultList').append(card);
  }
  if (result.web) {
    const box = el('article', 'web-card'); box.append(el('strong', '', '웹 검색 요약 · 원문 발췌문과 별개'));
    const content = el('p', 'answer-body'); appendAnswerText(content, result.web.summary, [], result.web.citations); box.append(content);
    result.web.citations.forEach(item => box.append(button(item.title + ' ↗', () => api.openLink(item.url), 'citation'))); $('resultList').append(box);
  }
}
function importResult(result) {
  if (!result) return;
  const added = result.outcomes.filter(item => item.ok && !item.duplicate).length, duplicates = result.outcomes.filter(item => item.duplicate).length;
  const errors = result.outcomes.filter(item => !item.ok);
  $('importSummary').textContent = added + '개 추가 · ' + duplicates + '개 중복 · ' + errors.length + '개 실패' + (result.cancelled ? ' · 중지됨' : '') + (result.capped ? ' · 최대 1,000개 또는 폴더 깊이 한도에 도달했습니다.' : '');
  $('importErrors').replaceChildren(); errors.forEach(item => $('importErrors').append(el('p', 'import-error', item.title + ' — ' + item.error)));
  if (!result.outcomes.length && !result.cancelled) $('importErrors').append(el('p', 'muted', '지원하는 자료 파일을 찾지 못했습니다. TXT·MD·CSV·HTML·PDF·DOCX를 선택해 주세요.'));
  if (!$('importDialog').open && !(result.cancelled && !result.outcomes.length)) $('importDialog').showModal();
}
async function openSettings() {
  status = await api.status(); $('apiKey').value = ''; $('aiEnabled').checked = status.settings.aiEnabled; $('consent').checked = status.settings.consent;
  $('importPolicy').value = status.settings.importPolicy; $('model').value = status.settings.model;
  $('keyStatus').textContent = status.keyError || (status.keyConfigured ? '암호화된 키 저장됨 · 새로 입력하면 교체합니다.' : '키 없이 로컬 검색을 사용할 수 있습니다.') + (status.encryptionAvailable ? '' : ' Windows 암호화를 사용할 수 없습니다.');
  $('settingsMessage').textContent = ''; if (!$('settingsDialog').open) $('settingsDialog').showModal();
}
$('settingsButton').addEventListener('click', () => openSettings().catch(error => notice(message(error))));
$('addButton').addEventListener('click', () => $('addDialog').showModal());
document.querySelectorAll('[data-close]').forEach(node => node.addEventListener('click', () => { if (node.dataset.close === 'settingsDialog') $('apiKey').value = ''; $(node.dataset.close).close(); }));
$('settingsDialog').addEventListener('close', () => { $('apiKey').value = ''; });
$('libraryFilter').addEventListener('input', renderSources);
['files','folder'].forEach(kind => $(kind === 'files' ? 'filesButton' : 'folderButton').addEventListener('click', async () => {
  $('addDialog').close(); const result = await runTask('자료를 선택합니다.', id => api.pickFiles(kind, id)); await refresh(); importResult(result);
}));
function tab(kind) { materialKind = kind; $('pasteFields').hidden = kind !== 'paste'; $('urlFields').hidden = kind !== 'url'; $('pasteTab').classList.toggle('active', kind === 'paste'); $('urlTab').classList.toggle('active', kind === 'url'); }
$('pasteTab').addEventListener('click', () => tab('paste')); $('urlTab').addEventListener('click', () => tab('url'));
$('materialForm').addEventListener('submit', async event => {
  event.preventDefault(); if (currentJob) return; const input = { kind: materialKind, title: $('materialTitle').value, text: $('materialText').value, url: $('materialUrl').value };
  $('addDialog').close(); const result = await runTask('자료를 추가합니다.', id => api.addMaterial(input, id)); await refresh();
  if (result) { $('materialText').value = ''; $('materialTitle').value = ''; $('materialUrl').value = ''; importResult(result); }
});
$('searchForm').addEventListener('submit', async event => {
  event.preventDefault(); const query = $('query').value.trim(); if (!query || currentJob) return; const revision = uiRevision;
  const result = await runTask('자료함에서 근거를 찾습니다.', id => api.search({ query, includeWeb: $('includeWeb').checked }, id));
  if (result && revision === uiRevision) { renderResults(result); await renderHistory(); $('intro').hidden = true; notice(result.warnings.join('\n')); $('query').value = ''; }
});
$('query').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('searchForm').requestSubmit(); } });
$('cancelButton').addEventListener('click', () => api.cancel().catch(error => notice(message(error))));
$('settingsForm').addEventListener('submit', async event => {
  event.preventDefault(); const key = $('apiKey').value; $('apiKey').value = '';
  try { status = await api.saveSettings({ key, aiEnabled: $('aiEnabled').checked, consent: $('consent').checked, importPolicy: $('importPolicy').value, model: $('model').value }); refreshMode(); $('settingsDialog').close(); notice('설정을 저장했습니다. 자료별 전송 설정은 자료함에서 바꿀 수 있습니다.'); }
  catch (error) { $('settingsMessage').textContent = message(error); }
});
$('checkKey').addEventListener('click', async () => { $('checkKey').disabled = true; try { const result = await api.checkKey(); $('settingsMessage').textContent = result.message; } catch (error) { $('settingsMessage').textContent = message(error); } finally { $('checkKey').disabled = false; } });
$('clearKey').addEventListener('click', async () => { try { status = await api.clearKey(); await openSettings(); refreshMode(); $('settingsMessage').textContent = 'OpenAI 키를 삭제하고 AI를 껐습니다.'; } catch (error) { $('settingsMessage').textContent = message(error); } });
$('clearHistory').addEventListener('click', async () => { try { const result = await api.clearHistory(); if (result.cleared) { resetResults(); await renderHistory(); $('settingsMessage').textContent = '저장된 대화를 지웠습니다.'; } } catch (error) { $('settingsMessage').textContent = message(error); } });
$('exportButton').addEventListener('click', async () => { try { const result = await api.saveReport(); if (result.saved) notice('결과를 저장했습니다.'); } catch (error) { notice(message(error)); } });
let dragDepth = 0;
window.addEventListener('dragenter', event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; } });
window.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = currentJob ? 'none' : 'copy'; } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropOverlay').hidden = true; });
window.addEventListener('drop', async event => {
  event.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true; if (currentJob) return;
  try { const paths = [...event.dataTransfer.files].map(file => api.filePath(file)).filter(Boolean); if (!paths.length) return;
    const result = await runTask('자료를 추가합니다.', id => api.dropFiles(paths, id)); await refresh(); importResult(result);
  } catch (error) { notice(message(error)); }
});
api.onActivity(value => { if (value.id === currentJob && value.detail) $('activity').textContent = value.detail; });
api.onLocal(value => { if (value.id === currentJob) renderResults(value); });
api.onLibrary(() => refresh().catch(error => notice(message(error))));
(async () => { await refresh(); await renderHistory(); })().catch(error => notice(message(error)));
