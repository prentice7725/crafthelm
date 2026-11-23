import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { canonicalJson, sha256Buffer } from './crypto.mjs';
import { isGitRepo, readFileAtRef } from './git.mjs';

/**
 * Human-gate helpers: keep human-only decisions (final acceptance) out of agent sessions.
 *
 * Three identity tiers are recorded in `verification_type`:
 * - `local_explicit_input_not_identity_verified`: programmatic call, nothing verified.
 * - `local_tty_confirmed_not_identity_verified`: interactive terminal outside a detected agent
 *   session, confirmed by typing a code. Proves presence at a terminal, not identity.
 * - `signed_ed25519`: record signed with a private key; trust comes from the protected approvers policy.
 */

export const VERIFICATION_TYPES = Object.freeze({
  EXPLICIT_INPUT: 'local_explicit_input_not_identity_verified',
  TTY_CONFIRMED: 'local_tty_confirmed_not_identity_verified',
  SIGNED: 'signed_ed25519',
});

export const APPROVERS_POLICY_PATH = '.crafthelm/approvers.json';

/**
 * Environment variables that AI agent hosts set for the commands they spawn.
 * Best-effort list: absence does not prove a human, so the TTY check stays the primary guard.
 * `CRAFTHELM_AGENT_SESSION` lets any host or wrapper declare an agent session explicitly.
 */
export const AGENT_SESSION_ENV_VARS = Object.freeze([
  'CRAFTHELM_AGENT_SESSION',
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'GEMINI_CLI',
  'ANTIGRAVITY_AGENT',
]);

/**
 * Detect whether the current process was spawned from an AI agent session.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ detected: boolean, signals: string[] }}
 */
export function detectAgentSession(env = process.env) {
  const signals = AGENT_SESSION_ENV_VARS.filter((name) => {
    const value = env[name];
    return value !== undefined && value !== '' && value !== '0' && value !== 'false';
  });
  return { detected: signals.length > 0, signals };
}

/**
 * Classify how a CLI approval was issued, for honest recording on lower-stakes approvals
 * (contract approval, stage gates) that an agent may be allowed to run after a permission prompt.
 * @param {{ env?: NodeJS.ProcessEnv, stdin?: { isTTY?: boolean }, stdout?: { isTTY?: boolean } }} [options]
 * @returns {'agent_session'|'interactive_terminal'|'non_interactive'}
 */
export function classifyApprovalChannel(options = {}) {
  if (detectAgentSession(options.env ?? process.env).detected) return 'agent_session';
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  return stdin.isTTY && stdout.isTTY ? 'interactive_terminal' : 'non_interactive';
}

/**
 * Throw unless the caller looks like a human at an interactive terminal.
 * A signed decision may skip the TTY requirement, never the agent-session check.
 * @param {{ env?: NodeJS.ProcessEnv, stdin?: { isTTY?: boolean }, stdout?: { isTTY?: boolean }, allowNonTty?: boolean, action?: string }} [options]
 */
export function assertHumanInteractive(options = {}) {
  const action = options.action ?? 'This command';
  const agent = detectAgentSession(options.env ?? process.env);
  if (agent.detected) {
    throw new Error(
      `HUMAN_GATE_AGENT_SESSION: ${action} must be run by a human outside an AI agent session ` +
        `(detected: ${agent.signals.join(', ')}). Run it yourself in a separate terminal.`,
    );
  }
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (!options.allowNonTty && !(stdin.isTTY && stdout.isTTY)) {
    throw new Error(
      `HUMAN_GATE_NO_TTY: ${action} requires an interactive terminal, or a signed decision via --sign-key.`,
    );
  }
}

/**
 * Ask the operator to type an expected code. Resolves true only on an exact match.
 * @param {{ expected: string, message: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} options
 * @returns {Promise<boolean>}
 */
export async function confirmByTyping(options) {
  const rl = readline.createInterface({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stderr,
  });
  try {
    const answer = await rl.question(options.message);
    return answer.trim() === options.expected;
  } finally {
    rl.close();
  }
}

function fingerprintPublicKey(publicKey) {
  return sha256Buffer(publicKey.export({ type: 'spki', format: 'der' }));
}

function loadEd25519PrivateKey(keyPath) {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`SIGN_KEY_UNSUPPORTED: expected an ed25519 private key, got ${privateKey.asymmetricKeyType}.`);
  }
  return privateKey;
}

/**
 * Fingerprint (SHA-256 of SPKI DER) of the public half of an ed25519 private key file.
 * @param {string} keyPath
 * @returns {string}
 */
export function fingerprintOfPrivateKeyFile(keyPath) {
  return fingerprintPublicKey(crypto.createPublicKey(loadEd25519PrivateKey(keyPath)));
}

function signablePayload(record) {
  const { signature: _signature, ...rest } = record;
  return Buffer.from(canonicalJson(rest), 'utf8');
}

/**
 * Sign a decision record (all fields except `signature`) with an ed25519 private key file.
 * @param {object} record
 * @param {string} keyPath
 * @returns {{ alg: 'ed25519', public_key_pem: string, public_key_fingerprint: string, value: string }}
 */
export function signDecisionRecord(record, keyPath) {
  const privateKey = loadEd25519PrivateKey(keyPath);
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    alg: 'ed25519',
    public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/\r\n/g, '\n'),
    public_key_fingerprint: fingerprintPublicKey(publicKey),
    value: crypto.sign(null, signablePayload(record), privateKey).toString('base64'),
  };
}

/**
 * Load the approvers policy from the protected base ref (never from the candidate working tree).
 * Without git or a usable base ref there is no protected copy, so the policy is reported absent.
 * @param {string} repoRoot
 * @param {string|null|undefined} baseRef
 * @returns {{ present: boolean, source: string, require_signed: boolean, approvers: Array<{ actor: string, public_key_fingerprint: string }> }}
 */
export function loadApproversPolicy(repoRoot, baseRef) {
  const absent = { present: false, source: 'none', require_signed: false, approvers: [] };
  if (!baseRef || baseRef === 'UNBORN' || baseRef === 'NO_GIT' || !isGitRepo(repoRoot)) {
    return absent;
  }
  const atRef = readFileAtRef(repoRoot, baseRef, APPROVERS_POLICY_PATH);
  if (!atRef.exists) return absent;

  const parsed = JSON.parse(atRef.content);
  const approvers = (Array.isArray(parsed.approvers) ? parsed.approvers : [])
    .filter((a) => a && typeof a.actor === 'string' && typeof a.public_key_fingerprint === 'string')
    .map((a) => ({ actor: a.actor.trim(), public_key_fingerprint: a.public_key_fingerprint.trim().toLowerCase() }));
  return {
    present: true,
    source: `base_ref_git_show:${baseRef}`,
    require_signed: parsed.require_signed === true,
    approvers,
  };
}

/**
 * Evaluate the identity strength of a decision record against the protected approvers policy.
 * @param {object} record
 * @param {ReturnType<typeof loadApproversPolicy>} policy
 * @returns {{ identity: 'UNSIGNED'|'SIGNATURE_INVALID'|'SIGNATURE_VALID_UNTRUSTED_KEY'|'SIGNATURE_TRUSTED', detail: string }}
 */
export function evaluateDecisionIdentity(record, policy) {
  const sig = record.signature;
  if (!sig) {
    return { identity: 'UNSIGNED', detail: 'decision record carries no signature' };
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(sig.public_key_pem);
  } catch {
    return { identity: 'SIGNATURE_INVALID', detail: 'embedded public key is not parseable' };
  }
  if (publicKey.asymmetricKeyType !== 'ed25519' || fingerprintPublicKey(publicKey) !== sig.public_key_fingerprint) {
    return { identity: 'SIGNATURE_INVALID', detail: 'embedded public key does not match its fingerprint' };
  }
  let signatureOk = false;
  try {
    signatureOk = crypto.verify(null, signablePayload(record), publicKey, Buffer.from(sig.value, 'base64'));
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return { identity: 'SIGNATURE_INVALID', detail: 'signature does not match the decision record' };
  }
  const trusted = policy.approvers.some(
    (a) => a.public_key_fingerprint === sig.public_key_fingerprint && a.actor === record.actor,
  );
  if (!trusted) {
    return {
      identity: 'SIGNATURE_VALID_UNTRUSTED_KEY',
      detail: policy.present
        ? 'signing key and actor are not listed together in the protected approvers policy'
        : 'no protected approvers policy exists to establish trust',
    };
  }
  return { identity: 'SIGNATURE_TRUSTED', detail: `actor and key listed in ${policy.source}` };
}

/**
 * Generate an ed25519 key pair for signing human decisions.
 * @returns {{ private_key_pem: string, public_key_pem: string, public_key_fingerprint: string }}
 */
export function generateApproverKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\r\n/g, '\n'),
    public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/\r\n/g, '\n'),
    public_key_fingerprint: fingerprintPublicKey(publicKey),
  };
}
