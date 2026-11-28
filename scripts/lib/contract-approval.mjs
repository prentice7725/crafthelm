import fs from 'node:fs';
import path from 'node:path';
import { sha256CanonicalJson } from './crypto.mjs';
import { getContractPath } from './paths.mjs';
import { writeAtomic } from './task-artifacts.mjs';

/**
 * The approved copy of a contract.
 *
 * Approval used to be a flag inside the contract file. Whoever edited the file kept the flag, so a
 * contract changed after it was approved (a check removed, a command swapped, the scope widened)
 * still read as approved, and a run could be opened on it. The approved content is therefore kept
 * outside the contract file, and the contract is compared with it wherever approval is relied on:
 * approving again, opening a run, re-planning.
 *
 * The copy lives under `.crafthelm/runs/`, which the snapshot leaves out and the scope guard closes
 * to file tools. It is a record to compare against, not a lock: a process that can write there can
 * rewrite it, as it can any other file in the repository.
 */

const APPROVALS_DIR = '.approvals';

/** The part of a contract an approval is about: everything except who approved it and when. */
export function contractBody(contract) {
  const body = structuredClone(contract);
  if (body.approval && typeof body.approval === 'object') {
    for (const key of Object.keys(body.approval)) {
      if (key.startsWith('contract_approved')) delete body.approval[key];
    }
  }
  return body;
}

export function contractBodyHash(contract) {
  return sha256CanonicalJson(contractBody(contract));
}

function approvalRecordPath(repoRoot, taskId) {
  return path.join(repoRoot, '.crafthelm', 'runs', APPROVALS_DIR, `${taskId}.json`);
}

/** The repository a contract file belongs to, when it sits at `.crafthelm/contracts/<task>.json`. */
export function repoOfCanonicalContract(contractFile, taskId) {
  const file = path.resolve(contractFile);
  const repo = path.resolve(path.dirname(file), '../..');
  return getContractPath(repo, taskId) === file ? repo : null;
}

/** @returns {{ task_id: string, body_sha256: string, approved_by: string, approved_at: string, approved_via: string, contract: object }|null} */
export function readApprovalRecord(repoRoot, taskId) {
  try {
    const record = JSON.parse(fs.readFileSync(approvalRecordPath(repoRoot, taskId), 'utf8'));
    return record && typeof record === 'object' && typeof record.body_sha256 === 'string' && record.contract ? record : null;
  } catch {
    return null;
  }
}

/** Keep the contract as it was approved. */
export function writeApprovalRecord(repoRoot, contract) {
  const file = approvalRecordPath(repoRoot, contract.task_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = {
    schema_version: '0.1',
    task_id: contract.task_id,
    body_sha256: contractBodyHash(contract),
    approved_by: contract.approval?.contract_approved_by ?? null,
    approved_at: contract.approval?.contract_approved_at ?? null,
    approved_via: contract.approval?.contract_approved_via ?? 'programmatic',
    contract,
  };
  writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

const same = (a, b) => sha256CanonicalJson(a ?? null) === sha256CanonicalJson(b ?? null);
const listed = (value) => (Array.isArray(value) ? value : []);

/**
 * What differs between an approved contract and the contract as it is now. `weakening` holds the
 * changes that make the contract ask for less or allow more: these are what an approver has to see.
 * @returns {{ changed: boolean, weakening: string[], other: string[] }}
 */
export function diffContracts(approved, current) {
  const weakening = [];
  const other = [];
  const before = contractBody(approved);
  const after = contractBody(current);

  const oldChecks = new Map(listed(before.acceptance).map((ac) => [ac.id, ac]));
  const newChecks = new Map(listed(after.acceptance).map((ac) => [ac.id, ac]));
  for (const [id, ac] of oldChecks) {
    const now = newChecks.get(id);
    if (!now) { weakening.push(`acceptance ${id} removed (was: ${ac.kind} ${JSON.stringify(ac.command ?? ac.manual_method ?? '')})`); continue; }
    if (same(ac, now)) continue;
    if (ac.command !== now.command) weakening.push(`acceptance ${id} command changed: ${JSON.stringify(ac.command ?? null)} -> ${JSON.stringify(now.command ?? null)}`);
    if (ac.kind !== now.kind) weakening.push(`acceptance ${id} kind changed: ${ac.kind} -> ${now.kind}`);
    if ((ac.expected_exit_code ?? 0) !== (now.expected_exit_code ?? 0)) weakening.push(`acceptance ${id} expected exit code changed: ${ac.expected_exit_code ?? 0} -> ${now.expected_exit_code ?? 0}`);
    if (ac.applicable !== false && now.applicable === false) weakening.push(`acceptance ${id} marked not applicable`);
    if (ac.requirement !== now.requirement) weakening.push(`acceptance ${id} now covers ${now.requirement} instead of ${ac.requirement}`);
    const keys = ['command', 'kind', 'expected_exit_code', 'applicable', 'requirement'];
    const rest = (x) => Object.fromEntries(Object.entries(x).filter(([k]) => !keys.includes(k)));
    if (!same(rest(ac), rest(now))) other.push(`acceptance ${id} changed in other fields`);
  }
  for (const [id, ac] of newChecks) {
    if (!oldChecks.has(id)) other.push(`acceptance ${id} added (${ac.kind} ${JSON.stringify(ac.command ?? ac.manual_method ?? '')})`);
  }

  const oldAllow = listed(before.scope?.allow);
  const newAllow = listed(after.scope?.allow);
  for (const p of newAllow) if (!oldAllow.includes(p)) weakening.push(`scope.allow widened: ${p} added`);
  for (const p of oldAllow) if (!newAllow.includes(p)) other.push(`scope.allow narrowed: ${p} removed`);
  const oldProtect = listed(before.scope?.protect);
  const newProtect = listed(after.scope?.protect);
  for (const p of oldProtect) if (!newProtect.includes(p)) weakening.push(`scope.protect: ${p} no longer protected`);
  for (const p of newProtect) if (!oldProtect.includes(p)) other.push(`scope.protect: ${p} added`);

  const oldReqs = new Map(listed(before.requirements).map((r) => [r.id, r.statement]));
  const newReqs = new Map(listed(after.requirements).map((r) => [r.id, r.statement]));
  for (const [id, statement] of oldReqs) {
    if (!newReqs.has(id)) weakening.push(`requirement ${id} removed (${statement})`);
    else if (newReqs.get(id) !== statement) other.push(`requirement ${id} reworded: ${JSON.stringify(statement)} -> ${JSON.stringify(newReqs.get(id))}`);
  }
  for (const [id, statement] of newReqs) if (!oldReqs.has(id)) other.push(`requirement ${id} added (${statement})`);

  if (!same(before.verification_policy, after.verification_policy)) weakening.push('verification_policy changed');
  if (!same(before.budgets, after.budgets)) weakening.push('budgets changed');
  const handled = new Set(['acceptance', 'scope', 'requirements', 'verification_policy', 'budgets']);
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!handled.has(key) && !same(before[key], after[key])) other.push(`${key} changed`);
  }
  for (const key of [...new Set([...Object.keys(before.scope ?? {}), ...Object.keys(after.scope ?? {})])].sort()) {
    if (key !== 'allow' && key !== 'protect' && !same(before.scope?.[key], after.scope?.[key])) other.push(`scope.${key} changed`);
  }
  return { changed: !same(before, after), weakening, other };
}

/** Lines for a terminal or an error message. */
export function describeContractDiff(diff) {
  if (!diff.changed) return ['The contract is the same as the approved copy.'];
  return [
    ...(diff.weakening.length > 0 ? ['Asks for less or allows more:', ...diff.weakening.map((line) => `  - ${line}`)] : []),
    ...(diff.other.length > 0 ? ['Other changes:', ...diff.other.map((line) => `  - ${line}`)] : []),
  ];
}

/**
 * Compare a contract with its approved copy.
 * @returns {{ status: 'MATCHES'|'CHANGED'|'NO_RECORD', record: object|null, diff: ReturnType<typeof diffContracts>|null }}
 */
export function compareWithApproved(repoRoot, contract) {
  const record = readApprovalRecord(repoRoot, contract.task_id);
  if (!record) return { status: 'NO_RECORD', record: null, diff: null };
  if (record.body_sha256 === contractBodyHash(contract)) return { status: 'MATCHES', record, diff: null };
  return { status: 'CHANGED', record, diff: diffContracts(record.contract, contract) };
}

/**
 * Stop unless the contract is the one that was approved. Used where approval is relied on.
 * @param {string} repoRoot
 * @param {object} contract an approved contract
 * @param {string} action what is about to happen, for the message
 */
export function assertContractIsApprovedCopy(repoRoot, contract, action) {
  const compared = compareWithApproved(repoRoot, contract);
  if (compared.status === 'MATCHES') return compared.record;
  if (compared.status === 'NO_RECORD') {
    throw new Error(`CONTRACT_APPROVAL_RECORD_MISSING: contract ${contract.task_id} is marked approved, but there is no record of what was approved, so ${action} cannot check it. Approve it again: contract approve --task-id ${contract.task_id} --repo <path> --actor <name>.`);
  }
  throw new Error([
    `CONTRACT_CHANGED_SINCE_APPROVAL: contract ${contract.task_id} is not what "${compared.record.approved_by}" approved at ${compared.record.approved_at}; ${action} stopped.`,
    ...describeContractDiff(compared.diff),
    `Review the changes (contract diff --task-id ${contract.task_id} --repo <path>) and approve the contract again with --accept-changes.`,
  ].join('\n'));
}
