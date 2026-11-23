import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getMemoryDecisionsDir, getMemoryIndexPath, getRunDir, toPosixPath } from './paths.mjs';

const VALID_DECISION_STATUSES = new Set(['active', 'superseded', 'decayed']);
const DEFAULT_HALF_LIFE_DAYS = 30;
const EPISODIC_KINDS = new Set(['failed_approach', 'escalation', 'review', 'human_decision']);

function parseFrontmatterScalar(rawVal) {
  const trimmed = String(rawVal ?? '').trim();
  if (trimmed === 'null' || trimmed === '~' || trimmed === '') return null;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map((item) => item.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    try {
      if (trimmed.startsWith('"')) return JSON.parse(trimmed);
    } catch {
      // Fallback to unquoting below
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function serializeFrontmatterValue(val) {
  if (val === null || val === undefined) return 'null';
  if (Array.isArray(val)) {
    const clean = val.map((v) => JSON.stringify(String(v))).join(', ');
    return `[${clean}]`;
  }
  return JSON.stringify(String(val));
}

/**
 * Parse a Markdown file with CraftHelm YAML frontmatter into metadata and body.
 * @param {string} markdownText
 * @returns {{ meta: Record<string, any>, body: string }}
 */
export function parseDecisionMarkdown(markdownText) {
  const text = String(markdownText ?? '').replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: text.trim() };
  }
  const meta = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1);
    if (key) meta[key] = parseFrontmatterScalar(val);
  }
  return { meta, body: match[2].trim() };
}

function renderDecisionMarkdown(meta, bodyText) {
  const fields = [
    ['id', meta.id],
    ['title', meta.title],
    ['status', meta.status ?? 'active'],
    ['supersedes', meta.supersedes ?? null],
    ['superseded_by', meta.superseded_by ?? null],
    ['task_id', meta.task_id ?? null],
    ['tags', Array.isArray(meta.tags) ? meta.tags : []],
    ['created_at', meta.created_at],
    ['updated_at', meta.updated_at],
  ];
  const yaml = fields.map(([k, v]) => `${k}: ${serializeFrontmatterValue(v)}`).join('\n');
  const cleanBody = String(bodyText ?? '').replace(/\r\n/g, '\n').trim();
  return `---\n${yaml}\n---\n\n${cleanBody}\n`;
}

function nextDecisionId(decisionsDir) {
  if (!fs.existsSync(decisionsDir)) return 'DEC-001';
  let maxNum = 0;
  for (const name of fs.readdirSync(decisionsDir)) {
    const m = name.match(/^DEC-(\d+)\.md$/i);
    if (m) maxNum = Math.max(maxNum, Number(m[1]));
  }
  return `DEC-${String(maxNum + 1).padStart(3, '0')}`;
}

/**
 * List structured architectural/workflow decisions from `.crafthelm/memory/decisions/*.md`.
 * @param {{ repo?: string, includeSuperseded?: boolean }} [options]
 */
export function listDecisions(options = {}) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const includeSuperseded = Boolean(options.includeSuperseded);
  const decisionsDir = getMemoryDecisionsDir(repoRoot);
  if (!fs.existsSync(decisionsDir)) return [];

  const entries = [];
  for (const fileName of fs.readdirSync(decisionsDir).sort()) {
    if (!fileName.endsWith('.md')) continue;
    const absPath = path.join(decisionsDir, fileName);
    const raw = fs.readFileSync(absPath, 'utf8');
    const { meta, body } = parseDecisionMarkdown(raw);
    const id = String(meta.id ?? path.basename(fileName, '.md'));
    const status = VALID_DECISION_STATUSES.has(meta.status) ? meta.status : 'active';
    if (!includeSuperseded && status === 'superseded') continue;
    entries.push({
      id,
      title: String(meta.title ?? id),
      status,
      supersedes: meta.supersedes ?? null,
      superseded_by: meta.superseded_by ?? null,
      task_id: meta.task_id ?? null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      created_at: meta.created_at ?? null,
      updated_at: meta.updated_at ?? null,
      source_path: toPosixPath(path.relative(repoRoot, absPath)),
      body,
    });
  }
  return entries;
}

/**
 * Record an active Markdown SOT decision and optionally mark an older decision as superseded.
 * Never deletes historical files; updates existing frontmatter with `status: superseded` and `superseded_by`.
 * @param {object} options
 */
export function recordDecision(options = {}) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const decisionsDir = getMemoryDecisionsDir(repoRoot);
  fs.mkdirSync(decisionsDir, { recursive: true });

  const id = String(options.id ?? nextDecisionId(decisionsDir)).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new Error(`Invalid decision ID "${id}". Use alphanumeric, hyphen, or underscore.`);
  }
  const title = String(options.title ?? '').trim();
  if (!title) {
    throw new Error('recordDecision requires --title');
  }

  const nowIso = options.recordedAt ?? new Date().toISOString();
  const supersedesId = options.supersedes ? String(options.supersedes).trim() : null;
  let supersededRecord = null;

  if (supersedesId) {
    if (supersedesId === id) {
      throw new Error(`Decision "${id}" cannot supersede itself.`);
    }
    const oldAbs = path.join(decisionsDir, `${supersedesId}.md`);
    if (!fs.existsSync(oldAbs)) {
      throw new Error(`Superseded decision "${supersedesId}" not found at ${toPosixPath(path.relative(repoRoot, oldAbs))}`);
    }
    const oldParsed = parseDecisionMarkdown(fs.readFileSync(oldAbs, 'utf8'));
    const updatedOldMeta = {
      ...oldParsed.meta,
      id: oldParsed.meta.id ?? supersedesId,
      title: oldParsed.meta.title ?? supersedesId,
      status: 'superseded',
      supersedes: oldParsed.meta.supersedes ?? null,
      superseded_by: id,
      created_at: oldParsed.meta.created_at ?? nowIso,
      updated_at: nowIso,
    };
    fs.writeFileSync(oldAbs, renderDecisionMarkdown(updatedOldMeta, oldParsed.body), 'utf8');
    supersededRecord = toPosixPath(path.relative(repoRoot, oldAbs));
  }

  const tags = Array.isArray(options.tags)
    ? options.tags.map((t) => String(t).trim()).filter(Boolean)
    : String(options.tags ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

  const bodyContent = String(options.body ?? options.rationale ?? `# ${id} — ${title}\n\n${title}`).trim();
  const meta = {
    id,
    title,
    status: 'active',
    supersedes: supersedesId,
    superseded_by: null,
    task_id: options.taskId ?? null,
    tags,
    created_at: nowIso,
    updated_at: nowIso,
  };

  const outAbs = path.join(decisionsDir, `${id}.md`);
  fs.writeFileSync(outAbs, renderDecisionMarkdown(meta, bodyContent), 'utf8');

  const indexResult = rebuildMemoryIndex({ repo: repoRoot, docsDir: options.docsDir });
  return {
    ok: true,
    id,
    title,
    status: 'active',
    supersedes: supersedesId,
    superseded_file: supersededRecord,
    decision_file: toPosixPath(path.relative(repoRoot, outAbs)),
    indexed_docs: indexResult.docs_indexed,
  };
}

function collectDocumentsForIndex(repoRoot, docsRelDir = 'docs') {
  const docs = [];
  const seenIds = new Set();
  const pushDoc = (doc) => {
    if (!doc || !doc.doc_id || seenIds.has(doc.doc_id)) return;
    seenIds.add(doc.doc_id);
    docs.push(doc);
  };

  // 1. Structured Markdown decisions under .crafthelm/memory/decisions/*.md
  for (const dec of listDecisions({ repo: repoRoot, includeSuperseded: true })) {
    pushDoc({
      doc_id: `decision:${dec.id}`,
      kind: 'decision',
      title: dec.title,
      body: dec.body,
      tags: [...dec.tags, dec.task_id ?? '', dec.supersedes ?? ''].filter(Boolean).join(' '),
      status: dec.status,
      superseded_by: dec.superseded_by,
      source_path: dec.source_path,
      recorded_at: dec.updated_at ?? dec.created_at ?? new Date().toISOString(),
    });
  }

  // 2. Interview docs/ and task-scoped docs/tasks/<taskId>/ (decisions.md, open_questions.md, requirements.md)
  const docSpecs = [
    ['decisions.md', 'decision', 'Project Decisions'],
    ['open_questions.md', 'open_question', 'Open Questions'],
    ['requirements.md', 'requirement', 'Project Requirements'],
  ];
  const collectDocDir = (relDir, titleSuffix = '') => {
    const absDir = path.join(repoRoot, relDir);
    if (!fs.existsSync(absDir)) return;
    for (const [fileName, kind, label] of docSpecs) {
      const abs = path.join(absDir, fileName);
      if (!fs.existsSync(abs)) continue;
      const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').trim();
      if (!text) continue;
      const mtime = fs.statSync(abs).mtime.toISOString();
      const normRelDir = toPosixPath(relDir);
      pushDoc({
        doc_id: `doc:${toPosixPath(path.join(normRelDir, fileName))}`,
        kind,
        title: titleSuffix ? `${label} (${titleSuffix})` : label,
        body: text,
        tags: `${normRelDir} ${fileName}`,
        status: 'active',
        superseded_by: null,
        source_path: toPosixPath(path.relative(repoRoot, abs)),
        recorded_at: mtime,
      });
    }
  };

  collectDocDir(docsRelDir);
  const taskDocsRoot = path.join(repoRoot, 'docs', 'tasks');
  if (fs.existsSync(taskDocsRoot)) {
    for (const entry of fs.readdirSync(taskDocsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      collectDocDir(path.join('docs', 'tasks', entry.name), entry.name);
    }
  }

  // 3. Run artifacts (.crafthelm/runs/<runId>/*)
  const runsRoot = path.join(repoRoot, '.crafthelm', 'runs');
  if (fs.existsSync(runsRoot)) {
    for (const runId of fs.readdirSync(runsRoot).sort()) {
      const runDir = getRunDir(repoRoot, runId);
      if (!fs.statSync(runDir).isDirectory()) continue;

      const evDir = path.join(runDir, 'evidence');
      if (fs.existsSync(evDir)) {
        for (const evFile of fs.readdirSync(evDir).sort()) {
          if (evFile.startsWith('repair-') && evFile.endsWith('.jsonl')) {
            const abs = path.join(evDir, evFile);
            const rel = toPosixPath(path.relative(repoRoot, abs));
            const fallbackTime = fs.statSync(abs).mtime.toISOString();
            for (const line of fs.readFileSync(abs, 'utf8').split(/\r?\n/)) {
              if (!line.trim()) continue;
              try {
                const rec = JSON.parse(line);
                pushDoc({
                  doc_id: `${runId}:repair:${rec.cause_id ?? 'cause'}:r${rec.round ?? 0}`,
                  kind: 'failed_approach',
                  title: `Failed repair ${rec.cause_id ?? 'cause'} round ${rec.round ?? 0} (${rec.check_id ?? 'unknown'})`,
                  body: `${rec.note ?? ''}\nCommand: ${rec.repro_command ?? 'not_provided'}`.trim(),
                  tags: [runId, rec.cause_id ?? '', rec.check_id ?? ''].filter(Boolean).join(' '),
                  status: 'active',
                  superseded_by: null,
                  source_path: rel,
                  recorded_at: rec.recorded_at ?? fallbackTime,
                });
              } catch {
                // Skip malformed jsonl line
              }
            }
          }
        }

        const escAbs = path.join(evDir, 'escalation.json');
        if (fs.existsSync(escAbs)) {
          try {
            const esc = JSON.parse(fs.readFileSync(escAbs, 'utf8'));
            const rel = toPosixPath(path.relative(repoRoot, escAbs));
            pushDoc({
              doc_id: `${runId}:escalation:${esc.cause_id ?? 'cause'}`,
              kind: 'escalation',
              title: `Escalation ${esc.cause_id ?? 'cause'} after ${esc.rounds_attempted ?? 0} rounds`,
              body: `Check: ${esc.failed_check_id ?? 'unknown'}\nCommand: ${esc.reproduction_command ?? ''}\nFiles: ${(esc.last_changed_files ?? []).join(', ')}`,
              tags: [runId, esc.cause_id ?? '', esc.failed_check_id ?? ''].filter(Boolean).join(' '),
              status: 'active',
              superseded_by: null,
              source_path: rel,
              recorded_at: esc.escalated_at ?? fs.statSync(escAbs).mtime.toISOString(),
            });
          } catch {
            // Skip invalid escalation.json
          }
        }
      }

      const histAbs = path.join(runDir, 'approvals', 'decisions-history.jsonl');
      if (fs.existsSync(histAbs)) {
        const rel = toPosixPath(path.relative(repoRoot, histAbs));
        const fallbackTime = fs.statSync(histAbs).mtime.toISOString();
        let idx = 0;
        for (const line of fs.readFileSync(histAbs, 'utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          idx += 1;
          try {
            const hd = JSON.parse(line);
            pushDoc({
              doc_id: `${runId}:human_decision:${idx}`,
              kind: 'human_decision',
              title: `Human decision ${hd.decision ?? 'unknown'} by ${hd.actor ?? 'operator'} (${runId})`,
              body: `${hd.rationale ?? ''}\nRisks: ${(hd.accepted_risks ?? []).join('; ')}`.trim(),
              tags: [runId, hd.task_id ?? '', hd.decision ?? '', hd.actor ?? ''].filter(Boolean).join(' '),
              status: 'active',
              superseded_by: null,
              source_path: rel,
              recorded_at: hd.recorded_at ?? fallbackTime,
            });
          } catch {
            // Skip invalid jsonl line
          }
        }
      }

      const pkgAbs = path.join(runDir, 'reports', 'review-package.md');
      if (fs.existsSync(pkgAbs)) {
        const rel = toPosixPath(path.relative(repoRoot, pkgAbs));
        const text = fs.readFileSync(pkgAbs, 'utf8').replace(/\r\n/g, '\n');
        pushDoc({
          doc_id: `${runId}:review-package`,
          kind: 'review',
          title: `Review Package ${runId}`,
          body: text.slice(0, 8000),
          tags: runId,
          status: 'active',
          superseded_by: null,
          source_path: rel,
          recorded_at: fs.statSync(pkgAbs).mtime.toISOString(),
        });
      }
    }
  }

  return docs;
}

/**
 * Rebuild `.crafthelm/memory/index.sqlite` FTS5 search index purely from Markdown & JSON SOT files on disk.
 * Never consumes LLM tokens; safe to delete and reconstruct at any time.
 * @param {{ repo?: string, docsDir?: string }} [options]
 */
export function rebuildMemoryIndex(options = {}) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const indexPath = getMemoryIndexPath(repoRoot);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });

  const docs = collectDocumentsForIndex(repoRoot, options.docsDir ?? 'docs');
  const countsByKind = {};
  for (const d of docs) {
    countsByKind[d.kind] = (countsByKind[d.kind] ?? 0) + 1;
  }

  const db = new DatabaseSync(indexPath);
  try {
    db.exec(`
      DROP TABLE IF EXISTS memory_fts;
      DROP TABLE IF EXISTS memory_docs;
      CREATE TABLE memory_docs (
        doc_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags TEXT NOT NULL,
        status TEXT NOT NULL,
        superseded_by TEXT,
        source_path TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE memory_fts USING fts5(
        doc_id UNINDEXED,
        title,
        body,
        tags,
        tokenize='unicode61'
      );
    `);

    const insertDoc = db.prepare(`
      INSERT INTO memory_docs (doc_id, kind, title, body, tags, status, superseded_by, source_path, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(`
      INSERT INTO memory_fts (doc_id, title, body, tags)
      VALUES (?, ?, ?, ?)
    `);

    db.exec('BEGIN');
    try {
      for (const d of docs) {
        insertDoc.run(d.doc_id, d.kind, d.title, d.body, d.tags, d.status, d.superseded_by ?? null, d.source_path, d.recorded_at);
        insertFts.run(d.doc_id, d.title, d.body, d.tags);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.close();
  }

  return {
    ok: true,
    index_file: toPosixPath(path.relative(repoRoot, indexPath)),
    docs_indexed: docs.length,
    counts_by_kind: countsByKind,
    rebuilt_at: new Date().toISOString(),
  };
}

/**
 * Convert arbitrary user/failure query strings into safe FTS5 MATCH tokens (`"tok"* OR ...`).
 * @param {string} rawQuery
 * @returns {string|null}
 */
export function buildFtsMatchQuery(rawQuery) {
  const reserved = new Set(['AND', 'OR', 'NOT', 'NEAR']);
  const tokens = [...new Set(String(rawQuery ?? '').match(/[\p{L}\p{N}_]+/gu) ?? [])]
    .filter((t) => !reserved.has(t.toUpperCase()));
  if (tokens.length === 0) return null;
  return tokens
    .slice(0, 12)
    .map((t) => (t.length >= 2 ? `"${t}"*` : `"${t}"`))
    .join(' OR ');
}

function makeExcerpt(body, maxLen = 220) {
  const clean = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 3)}...`;
}

/**
 * Search derived SQLite FTS5 memory index with supersession awareness and exponential time decay
 * for episodic logs (`failed_approach`, `escalation`, `review`, `human_decision`).
 * @param {{ repo?: string, query?: string, kind?: string, includeSuperseded?: boolean, limit?: number, halfLifeDays?: number, now?: string|number, rebuild?: boolean }} [options]
 */
export function searchMemory(options = {}) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const indexPath = getMemoryIndexPath(repoRoot);
  const ftsQuery = buildFtsMatchQuery(options.query ?? '');
  const includeSuperseded = Boolean(options.includeSuperseded);
  const limit = Math.max(1, Number(options.limit ?? 10));
  const halfLifeDays = Math.max(1, Number(options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS));
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();

  if (options.rebuild || !fs.existsSync(indexPath)) {
    rebuildMemoryIndex({ repo: repoRoot, docsDir: options.docsDir });
  }

  if (!ftsQuery) {
    return {
      ok: true,
      query: options.query ?? '',
      fts_query: null,
      hits: [],
    };
  }

  const hits = [];
  const db = new DatabaseSync(indexPath);
  try {
    const rows = db.prepare(`
      SELECT d.doc_id, d.kind, d.title, d.body, d.status, d.superseded_by, d.source_path, d.recorded_at,
             bm25(memory_fts) AS bm25_score
      FROM memory_fts
      JOIN memory_docs d ON d.doc_id = memory_fts.doc_id
      WHERE memory_fts MATCH ?
      LIMIT 100
    `).all(ftsQuery);

    for (const row of rows) {
      if (options.kind && row.kind !== options.kind) continue;
      if (!includeSuperseded && row.status === 'superseded') continue;

      const recordedMs = Date.parse(row.recorded_at);
      const ageDays = Number.isFinite(recordedMs) ? Math.max(0, (nowMs - recordedMs) / (1000 * 60 * 60 * 24)) : 0;

      let weight = 1.0;
      let decayed = false;
      if (row.status === 'superseded') {
        weight = 0.25;
      } else if (row.kind === 'decision') {
        weight = 1.2;
      } else if (EPISODIC_KINDS.has(row.kind)) {
        weight = Math.max(0.15, Math.pow(0.5, ageDays / halfLifeDays));
        decayed = ageDays >= halfLifeDays * 2;
      }

      const rawRelevance = Math.max(0.01, -Number(row.bm25_score ?? 0) + 1.0);
      const finalScore = Number((rawRelevance * weight).toFixed(4));
      const cleanId = String(row.doc_id).replace(/^decision:/, '');

      hits.push({
        id: cleanId,
        kind: row.kind,
        title: row.title,
        status: decayed && row.status === 'active' ? 'decayed' : row.status,
        ...(row.superseded_by ? { superseded_by: row.superseded_by } : {}),
        source_path: row.source_path,
        score: finalScore,
        decayed,
        age_days: Number(ageDays.toFixed(1)),
        recorded_at: row.recorded_at,
        excerpt: makeExcerpt(row.body),
      });
    }
  } finally {
    db.close();
  }

  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    ok: true,
    query: options.query ?? '',
    fts_query: ftsQuery,
    hits: hits.slice(0, limit),
  };
}

/**
 * Helper to check if a repository has any existing CraftHelm memory/run/doc sources worth searching.
 * @param {string} repoRoot
 */
export function hasMemorySources(repoRoot) {
  if (fs.existsSync(getMemoryIndexPath(repoRoot))) return true;
  const decDir = getMemoryDecisionsDir(repoRoot);
  if (fs.existsSync(decDir) && fs.readdirSync(decDir).some((f) => f.endsWith('.md'))) return true;
  const runsDir = path.join(repoRoot, '.crafthelm', 'runs');
  if (fs.existsSync(runsDir) && fs.readdirSync(runsDir).length > 0) return true;
  return false;
}
