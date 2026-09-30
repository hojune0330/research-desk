const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const digest = text => createHash('sha256').update(text).digest('hex');
function chunksFromSections(sections) {
  const chunks = [];
  for (const section of sections) {
    const lines = section.text.replace(/\r\n?/g, '\n').split('\n');
    let parts = [], length = 0, start = 1;
    const flush = end => {
      const text = parts.join('\n').trim();
      if (text) chunks.push({ text, location: section.page ? { kind: 'page', page: section.page } : { kind: 'lines', start, end } });
    };
    for (let i = 0; i < lines.length; i++) {
      // Split exceptionally long lines; line anchors refer to extracted text.
      const segments = lines[i].match(/[\s\S]{1,1600}/gu) || [''];
      for (const segment of segments) {
        if (length + segment.length > 2400 && parts.length) {
          flush(i + 1); parts = []; length = 0; start = i + 1;
        }
        parts.push(segment); length += segment.length + 1;
      }
    }
    flush(lines.length);
  }
  if (chunks.length > 4000) throw new Error('자료의 텍스트가 너무 큽니다. 파일을 나누어 추가해 주세요.');
  return chunks;
}
function queryTerms(query) {
  const words = query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const stop = new Set(['찾아줘','찾아','검색','자료','정리해줘','정리','비교해줘','알려줘','있는','하는','대한','관련','그리고','please','find','the','and','for','with']);
  const terms = [];
  for (const word of words) {
    if (stop.has(word)) continue;
    terms.push(word);
    const stem = word.replace(/(에서는|에서|으로|까지|부터|처럼|에게|보다|에는|은|는|이|가|을|를|의|에|도|과|와)$/u, '');
    if (stem.length >= 2 && stem !== word) terms.push(stem);
  }
  return [...new Set(terms)].filter(term => term.length >= 2).slice(0, 20);
}
class Library {
  constructor(root) { this.root = root; this.revision = 0; }
  async open() {
    await fs.mkdir(path.join(this.root, 'originals'), { recursive: true });
    this.db = new DatabaseSync(path.join(this.root, 'library.sqlite'));
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, origin TEXT NOT NULL,
        original TEXT, hash TEXT UNIQUE NOT NULL, policy TEXT NOT NULL DEFAULT 'local_only',
        revision INTEGER NOT NULL DEFAULT 1, policy_revision INTEGER NOT NULL DEFAULT 1,
        created TEXT NOT NULL, characters INTEGER NOT NULL, aliases TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        text TEXT NOT NULL, location TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(chunk_id UNINDEXED, text, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, query TEXT NOT NULL, answer TEXT NOT NULL, refs TEXT NOT NULL,
        sent TEXT NOT NULL, web TEXT NOT NULL, usage TEXT NOT NULL, created TEXT NOT NULL,
        invalidated INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version=1;`);
    return this;
  }
  list(filter = '') {
    return this.db.prepare('SELECT id,title,kind,origin,policy,created,characters,aliases FROM sources ORDER BY created DESC').all()
      .filter(item => !filter || item.title.toLowerCase().includes(filter.toLowerCase()))
      .map(item => ({ ...item, aliases: JSON.parse(item.aliases) }));
  }
  count() { return this.db.prepare('SELECT count(*) AS count FROM sources').get().count; }
  source(id) { return this.db.prepare('SELECT * FROM sources WHERE id=?').get(id); }
  async add({ title, kind, origin, buffer, extension, sections, policy = 'local_only' }) {
    const chunks = chunksFromSections(sections);
    if (!chunks.length) throw new Error('읽을 수 있는 텍스트가 없습니다. 스캔 PDF는 OCR이 필요합니다.');
    const text = sections.map(section => section.text).join('\n');
    if (text.length > 2_000_000) throw new Error('추출 텍스트는 자료당 200만 자까지 지원합니다.');
    const hash = digest(kind === 'file' ? buffer : text);
    const existing = this.db.prepare('SELECT id,aliases,title FROM sources WHERE hash=?').get(hash);
    if (existing) {
      const aliases = JSON.parse(existing.aliases);
      const alias = { title, origin };
      if (existing.title !== title && !aliases.some(item => item.title === title && item.origin === origin)) {
        aliases.push(alias);
        this.db.prepare('UPDATE sources SET aliases=? WHERE id=?').run(JSON.stringify(aliases), existing.id);
      }
      return { duplicate: true, id: existing.id, title };
    }
    const id = randomUUID();
    const original = kind === 'file' ? path.join(this.root, 'originals', id + extension) : null;
    if (original) await fs.writeFile(original, buffer, { flag: 'wx' });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO sources(id,title,kind,origin,original,hash,policy,created,characters) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, title, kind, origin, original, hash, policy, new Date().toISOString(), text.length);
      const insert = this.db.prepare('INSERT INTO chunks(id,source_id,text,location) VALUES(?,?,?,?)');
      const index = this.db.prepare('INSERT INTO chunk_search(chunk_id,text) VALUES(?,?)');
      chunks.forEach((chunk, i) => { const chunkId = id + ':' + i; insert.run(chunkId, id, chunk.text, JSON.stringify(chunk.location)); index.run(chunkId, chunk.text); });
      this.db.exec('COMMIT'); this.revision++;
    } catch (error) { this.db.exec('ROLLBACK'); if (original) await fs.rm(original, { force: true }); throw error; }
    return { duplicate: false, id, title };
  }
  search(query, limit = 24) {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const rows = new Map();
    const fts = terms.filter(term => [...term].length >= 3).map(term => '"' + term.replace(/"/g, '""') + '"').join(' OR ');
    if (fts) {
      const found = this.db.prepare(`SELECT c.*,s.title,s.kind,s.policy,s.revision,s.policy_revision,s.origin
        FROM chunk_search f JOIN chunks c ON c.id=f.chunk_id JOIN sources s ON s.id=c.source_id
        WHERE chunk_search MATCH ? ORDER BY bm25(chunk_search) LIMIT 240`).all(fts);
      found.forEach(row => rows.set(row.id, row));
    }
    const clauses = terms.map(() => "(c.text LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')").join(' OR ');
    const args = terms.flatMap(term => { const value = '%' + term.replace(/[\\%_]/g, '\\$&') + '%'; return [value, value]; });
    const extra = this.db.prepare(`SELECT c.*,s.title,s.kind,s.policy,s.revision,s.policy_revision,s.origin
      FROM chunks c JOIN sources s ON s.id=c.source_id WHERE ${clauses} LIMIT 240`).all(...args);
    extra.forEach(row => rows.set(row.id, row));
    const ranked = [...rows.values()].map(row => {
      const text = row.text.normalize('NFKC').toLowerCase(), title = row.title.normalize('NFKC').toLowerCase();
      const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0) + (title.includes(term) ? 1.5 : 0), 0);
      return { ...row, location: JSON.parse(row.location), score };
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const perSource = new Map();
    return ranked.filter(row => { const count = perSource.get(row.source_id) || 0; perSource.set(row.source_id, count + 1); return count < 3; })
      .slice(0, limit).map((row, i) => ({ chunkId: row.id, sourceId: row.source_id, sourceRevision: row.revision, policyRevision: row.policy_revision,
        title: row.title, kind: row.kind, publicUrl: row.kind === 'url' ? row.origin : null,
        text: row.text, location: row.location, policy: row.policy, baseRank: i + 1 }));
  }
  eligible(passages) {
    return passages.filter(passage => { const source = this.source(passage.sourceId);
      return source && source.policy === 'ai_allowed' && source.revision === passage.sourceRevision && source.policy_revision === passage.policyRevision;
    });
  }
  setPolicy(id, policy) {
    if (!['local_only', 'ai_allowed'].includes(policy)) throw new Error('자료의 전송 설정이 올바르지 않습니다.');
    if (!this.source(id)) throw new Error('자료가 삭제되었거나 존재하지 않습니다.');
    this.db.prepare('UPDATE sources SET policy=?,policy_revision=policy_revision+1 WHERE id=?').run(policy, id);
    if (policy === 'local_only') this.invalidateHistory(id);
    this.revision++;
  }
  invalidateHistory(id, purgeExcerpts = false) {
    for (const turn of this.db.prepare('SELECT id,refs,sent FROM conversations WHERE invalidated=0').all()) {
      if ([...JSON.parse(turn.refs), ...JSON.parse(turn.sent)].some(ref => ref.sourceId === id)) {
        this.db.prepare('UPDATE conversations SET invalidated=1 WHERE id=?').run(turn.id);
      }
    }
    if (purgeExcerpts) {
      for (const turn of this.db.prepare('SELECT id,sent FROM conversations').all()) {
        const sent = JSON.parse(turn.sent).map(ref => ref.sourceId === id ? { ...ref, text: undefined } : ref);
        this.db.prepare('UPDATE conversations SET sent=? WHERE id=?').run(JSON.stringify(sent), turn.id);
      }
    }
  }
  async remove(id) {
    const source = this.source(id); if (!source) return;
    // Delete the managed original first; on failure leave a recoverable indexed source.
    if (source.original) await fs.rm(source.original, { force: true });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.invalidateHistory(id, true);
      this.db.prepare('DELETE FROM chunk_search WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id=?)').run(id);
      this.db.prepare('DELETE FROM sources WHERE id=?').run(id);
      this.db.exec('COMMIT'); this.revision++;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveTurn(turn) {
    this.db.prepare('INSERT INTO conversations(id,query,answer,refs,sent,web,usage,created) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), turn.query, turn.answer, JSON.stringify(turn.refs), JSON.stringify(turn.sent), JSON.stringify(turn.web), JSON.stringify(turn.usage), new Date().toISOString());
  }
  history(limit = 30) {
    return this.db.prepare('SELECT * FROM conversations ORDER BY created DESC LIMIT ?').all(limit).reverse()
      .map(turn => ({ ...turn, refs: JSON.parse(turn.refs), sent: JSON.parse(turn.sent), web: JSON.parse(turn.web), usage: JSON.parse(turn.usage), invalidated: Boolean(turn.invalidated) }));
  }
  clearHistory() { this.db.exec('DELETE FROM conversations'); }
  close() { this.db?.close(); }
}
module.exports = { Library, chunksFromSections, queryTerms };
