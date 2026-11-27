import fs from 'node:fs';
import path from 'node:path';
import { normalizeHostId } from '../hosts/registry.mjs';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { collectRelativeFiles, sha256File } from './lib/crypto.mjs';
import { KOUETSU_FALLBACK_VERSION, verifyKouetsuAsset } from './lib/kouetsu-check.mjs';
import { CRAFTHELM_ROOT, getSkillLockPath } from './lib/paths.mjs';
import { assertValidSchema } from './lib/schema.mjs';

const EXECUTABLE_EXTENSIONS = new Set(['.sh', '.bash', '.ps1', '.bat', '.cmd', '.py', '.js', '.mjs', '.cjs', '.rb']);
const NETWORK_PATTERN = /(?:https?:\/\/|curl\s+|wget\s+|fetch\s*\(|node:http|node:https|net\.connect)/i;
const CREDENTIAL_PATTERN = /(?:\.env\b|ANTHROPIC_API_KEY|OPENAI_API_KEY|AWS_SECRET|id_rsa|~\/\.ssh|process\.env)/;

const KNOWN_PROVIDER_PATTERNS = {
  claude: [/\bclaude\b/i],
  codex: [/\bcodex\b/i],
  antigravity: [/\bagy\b/i, /\bantigravity\b/i],
  grok: [/\bgrok\b/i],
};

function getForbiddenProviderPatterns(host) {
  const normHost = normalizeHostId(host);
  const patterns = [];
  for (const [provider, rxList] of Object.entries(KNOWN_PROVIDER_PATTERNS)) {
    if (provider !== normHost) {
      patterns.push(...rxList);
    }
  }
  return patterns;
}

function readRegistry(registryPath) {
  const target = registryPath ?? path.join(CRAFTHELM_ROOT, 'external-skills', 'registry.json');
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

export function listSkills(options = {}) {
  const reg = readRegistry(options.registryPath);
  return reg.entries ?? [];
}

/**
 * Perform static security, single-provider isolation, and command-conflict audit on an external skill directory (`E08`).
 * @param {string} skillPath
 * @param {{ host?: string, reservedCommands?: string[], allowScripts?: boolean, allowNetwork?: boolean }} [options]
 */
export function auditSkillDirectory(skillPath, options = {}) {
  const absPath = path.resolve(skillPath);
  const host = normalizeHostId(options.host ?? 'generic');
  const reserved = new Set(options.reservedCommands ?? ['crafthelm-interview', 'crafthelm-plan', 'crafthelm-verify']);

  if (!fs.existsSync(absPath)) {
    return { ok: false, status: 'NOT_FOUND', blocks: [{ code: 'NOT_FOUND', message: `Skill directory not found: ${absPath}` }] };
  }

  const files = collectRelativeFiles(absPath);
  const blocks = [];
  const warnings = [];
  let declaredName = path.basename(absPath);

  for (const rel of files) {
    const filePath = path.join(absPath, rel);
    const ext = path.extname(rel).toLowerCase();
    const content = fs.readFileSync(filePath, 'utf8');

    if (rel.toLowerCase() === 'skill.md') {
      const nameMatch = content.match(/^name:\s*([^\r\n]+)/m);
      if (nameMatch) {
        declaredName = nameMatch[1].trim();
        if (reserved.has(declaredName)) {
          blocks.push({
            code: 'SKILL_CONFLICT',
            file: rel,
            message: `Skill name "${declaredName}" conflicts with reserved built-in command/skill`,
          });
        }
      }
      const cmdMatch = content.match(/^command:\s*([^\r\n]+)/m);
      if (cmdMatch && reserved.has(cmdMatch[1].trim())) {
        blocks.push({
          code: 'SKILL_CONFLICT',
          file: rel,
          message: `Declared command "${cmdMatch[1].trim()}" conflicts with reserved command`,
        });
      }
    }

    if (EXECUTABLE_EXTENSIONS.has(ext) && !options.allowScripts) {
      blocks.push({
        code: 'SECURITY_BLOCK',
        file: rel,
        message: `Unapproved executable script found (${rel}); human permission review required`,
      });
    }

    if (NETWORK_PATTERN.test(content) && !options.allowNetwork) {
      // Allow mere upstream reference URLs inside SKILL.md/NOTICE.md documentation headers
      const isDocMetadataOnly = (rel === 'SKILL.md' || rel === 'NOTICE.md' || rel === 'README.md')
        && !/(?:curl\s+|wget\s+|fetch\s*\()/i.test(content);
      if (!isDocMetadataOnly) {
        blocks.push({
          code: 'SECURITY_BLOCK',
          file: rel,
          message: `Network access pattern detected in ${rel}`,
        });
      }
    }

    if (CREDENTIAL_PATTERN.test(content)) {
      blocks.push({
        code: 'SECURITY_BLOCK',
        file: rel,
        message: `Credential/secret access pattern detected in ${rel}`,
      });
    }

    // Check cross-provider CLI invocations in executable scripts or explicit command instructions
    const forbiddenProviders = getForbiddenProviderPatterns(host);
    for (const pat of forbiddenProviders) {
      const bare = pat.source;
      const invocationRx = new RegExp(
        `(?:\\b(?:exec|spawn|run|invoke|call)\\s+(?:the\\s+)?${bare}|\\\`(?:\\$\\s*)?${bare}\\b|\\$\\s*${bare}\\b|\\b${bare}\\s+(?:exec|cli|--print|-p|--model))`,
        'i',
      );
      const hasCommandInvocation = invocationRx.test(content)
        || (EXECUTABLE_EXTENSIONS.has(ext) && pat.test(content));
      if (hasCommandInvocation) {
        blocks.push({
          code: 'SINGLE_PROVIDER_CONFLICT',
          file: rel,
          message: `Cross-provider CLI reference (${pat.source}) violates ${host}-only single-provider invariant`,
        });
      }
    }

    if (/hooks\s*:/i.test(content) && rel !== 'SKILL.md') {
      warnings.push(`Hook configuration detected in ${rel}; requires explicit approval`);
    }
  }

  return {
    ok: blocks.length === 0,
    status: blocks.length === 0 ? 'APPROVED_STATIC_CANDIDATE' : blocks[0].code,
    skill_name: declaredName,
    host,
    files_inspected: files.length,
    blocks,
    warnings,
  };
}

/**
 * Pin approved external skills (starting with Kouetsu) into `.crafthelm/skills.lock.json`.
 */
export function lockApprovedSkills(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const host = normalizeHostId(options.host ?? 'generic');
  const reg = readRegistry(options.registryPath);
  const kouetsuEntry = (reg.entries ?? []).find((e) => e.id === 'kouetsu');
  const asset = verifyKouetsuAsset(host, {
    kouetsuRoot: options.kouetsuRoot,
    homeDir: options.homeDir,
    registryPath: options.registryPath,
    repoRoot,
  });

  if (!asset.found || asset.status === 'TAMPERED') {
    throw new Error(`Cannot lock kouetsu for host "${host}": asset status is ${asset.status}`);
  }

  const auditRes = auditSkillDirectory(asset.path, { host });
  if (!auditRes.ok) {
    throw new Error(`Audit failed for kouetsu at ${asset.path}: ${auditRes.blocks.map((b) => b.message).join('; ')}`);
  }

  const lockData = {
    schema_version: '0.3',
    generated_at: new Date().toISOString(),
    host,
    skills: [
      {
        id: 'kouetsu',
        version: kouetsuEntry?.commit_or_release ?? KOUETSU_FALLBACK_VERSION,
        license: kouetsuEntry?.license ?? 'MIT',
        upstream_url: kouetsuEntry?.upstream_url ?? 'https://github.com/prentice7725/kouetsu',
        source_path: asset.path,
        files_digest: asset.filesDigest,
        file_hashes: asset.fileHashes,
        permission_scope: kouetsuEntry?.permission_scope ?? ['read_markdown'],
        approved_at: kouetsuEntry?.last_reviewed ?? new Date().toISOString(),
      },
    ],
  };

  assertValidSchema('skill-lock', lockData, 'skills.lock.json');
  const lockPath = getSkillLockPath(repoRoot);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(lockData, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    lock_path: lockPath,
    lock_sha256: sha256File(lockPath),
    skills_locked: lockData.skills.map((s) => `${s.id}@${s.version}`),
  };
}

/**
 * Re-verify all pinned file SHA-256 hashes inside `.crafthelm/skills.lock.json`.
 */
export function verifySkillLock(options) {
  const repoRoot = path.resolve(options.repo ?? '.');
  const lockPath = getSkillLockPath(repoRoot);
  if (!fs.existsSync(lockPath)) {
    return { ok: false, status: 'MISSING_LOCKFILE', mismatches: ['skills.lock.json does not exist'] };
  }
  const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assertValidSchema('skill-lock', lockData, lockPath);

  const mismatches = [];
  for (const skill of lockData.skills) {
    for (const [rel, expectedSha] of Object.entries(skill.file_hashes)) {
      const target = path.join(skill.source_path, rel);
      if (!fs.existsSync(target)) {
        mismatches.push(`${skill.id}:${rel} missing at ${target}`);
        continue;
      }
      const actualSha = sha256File(target);
      if (actualSha !== expectedSha) {
        mismatches.push(`${skill.id}:${rel} SHA-256 mismatch`);
      }
    }
  }

  return {
    ok: mismatches.length === 0,
    status: mismatches.length === 0 ? 'VERIFIED' : 'TAMPERED',
    host: lockData.host,
    skills: lockData.skills.map((s) => s.id),
    mismatches,
  };
}

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm External Skills CLI (List, Security Audit & Lock Verification)',
      '',
      'Usage:',
      '  skills.mjs list [--registry <path>]',
      '  skills.mjs audit <dir> [--host <host>]',
      '  skills.mjs lock [--repo .] [--host <host>] [--kouetsu-root <path>]',
      '  skills.mjs verify-lock [--repo .]',
      '',
    ].join('\n'),
  );
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (isHelpRequested(argv)) {
    printUsage();
    process.exit(0);
  }
  const args = parseArgs(argv);
  const sub = args._[0] ?? 'list';
  try {
    let out;
    if (sub === 'list') {
      out = listSkills({ registryPath: args.registry });
    } else if (sub === 'audit') {
      out = auditSkillDirectory(args._[1] ?? args.path, { host: args.host ?? 'generic' });
    } else if (sub === 'lock') {
      out = lockApprovedSkills({
        repo: args.repo ?? '.',
        host: args.host ?? 'generic',
        kouetsuRoot: args['kouetsu-root'],
      });
    } else if (sub === 'verify-lock') {
      out = verifySkillLock({ repo: args.repo ?? '.' });
    } else {
      throw new Error('Usage: skills.mjs <list|audit|lock|verify-lock> ...');
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (out && out.ok === false) process.exit(1);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
