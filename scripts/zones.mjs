import path from 'node:path';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { classifyApprovalChannel } from './lib/human-gate.mjs';
import { ZONES_POLICY_PATH, classifyZone, inspectZones, loadZonesPolicy, setLightContracts, writeZones } from './lib/zones.mjs';

const STATUS_NOTE = {
  UNDEFINED: 'This project has not decided its strict zones. Decide them with the user from the project\'s design: where is a mistake expensive? Then record the answer with "zones set".',
  NOT_COMMITTED: `${ZONES_POLICY_PATH} exists but is not committed. Runs are judged by the committed file, so commit it.`,
  DIFFERS_FROM_HEAD: `${ZONES_POLICY_PATH} differs from the committed version. Runs are judged by the committed file until this one is committed.`,
  COMMITTED: 'The zones are committed. A run uses the version at its baseline.',
};

// "<path>::<reason>". The separator is doubled because a path may hold a single colon.
function parseStrict(values) {
  return (Array.isArray(values) ? values : values === undefined ? [] : [values]).map((value) => {
    const text = String(value);
    const at = text.indexOf('::');
    return at < 0 ? { path: text, reason: '' } : { path: text.slice(0, at), reason: text.slice(at + 2) };
  });
}

function printUsage() {
  process.stdout.write([
    'CraftHelm Project Zones (which paths this project treats as strict)',
    '',
    'Usage:',
    '  zones.mjs show  --repo <path>',
    '  zones.mjs set   --repo <path> --actor <name> --strict "<path>::<reason>" [--strict ...] [--basis "<text>"]',
    '  zones.mjs set   --repo <path> --actor <name> --none [--basis "<text>"]',
    '  zones.mjs set-light --repo <path> --actor <name> --mode <standing|ask>',
    '  zones.mjs check --repo <path> --files <a,b,...>',
    '',
    'A strict zone is a path where a mistake is expensive for this project; everything else is light.',
    'The project decides this once, from its design and with its users, when it is set up. CraftHelm',
    'ships no list of its own. --none records the decision that the project has no strict zone.',
    `The decision is written to ${ZONES_POLICY_PATH}; a run is judged by the version committed at its baseline.`,
    '',
    'set-light decides how a contract that cannot reach a strict zone is started: "ask" the user each time',
    '(the default), or "standing": the project\'s rule starts it, with no approval prompt. Final acceptance',
    'is not affected. Redefining the zones with "set" puts this back to "ask".',
    '',
  ].join('\n'));
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (isHelpRequested(argv)) {
    printUsage();
    process.exit(0);
  }
  const args = parseArgs(argv, { multiFlags: ['strict'] });
  const sub = args._[0];
  const repoRoot = path.resolve(typeof args.repo === 'string' ? args.repo : '.');
  try {
    if (sub === 'show') {
      const state = inspectZones(repoRoot);
      process.stderr.write(`${STATUS_NOTE[state.status]}\n`);
      process.stdout.write(`${JSON.stringify({
        status: state.status,
        working: state.working,
        committed: state.committed.present ? { strict: state.committed.strict, decided_by: state.committed.decided_by, decided_at: state.committed.decided_at, light_contracts: state.committed.light_contracts } : null,
      }, null, 2)}\n`);
    } else if (sub === 'set') {
      const strict = parseStrict(args.strict);
      if (strict.length === 0 && !args.none) {
        throw new Error('zones set needs at least one --strict "<path>::<reason>", or --none to record that this project has no strict zone.');
      }
      if (strict.length > 0 && args.none) throw new Error('zones set takes --strict or --none, not both.');
      const channel = classifyApprovalChannel();
      const zones = writeZones(repoRoot, { strict, actor: args.actor, basis: typeof args.basis === 'string' ? args.basis : undefined, channel });
      if (channel === 'agent_session') {
        process.stderr.write(`[notice] These zones were recorded inside an AI agent session, under the name "${zones.decided_by}". Use a person's name only if that person decided them in the conversation.\n`);
      }
      process.stderr.write(`${STATUS_NOTE[inspectZones(repoRoot).status]}\n`);
      process.stdout.write(`${JSON.stringify({ ok: true, path: ZONES_POLICY_PATH, zones }, null, 2)}\n`);
    } else if (sub === 'set-light') {
      const channel = classifyApprovalChannel();
      const zones = setLightContracts(repoRoot, { mode: args.mode, actor: args.actor, channel });
      if (channel === 'agent_session') {
        process.stderr.write(`[notice] This was recorded inside an AI agent session, under the name "${zones.light_contracts.decided_by}". Use a person's name only if that person decided it in the conversation.\n`);
      }
      process.stderr.write(zones.light_contracts.mode === 'standing'
        ? 'Once committed, a contract whose scope cannot reach a strict zone can be started with "contract begin", without an approval prompt. Final acceptance is unchanged.\n'
        : 'Once committed, every contract is approved by the user again.\n');
      process.stdout.write(`${JSON.stringify({ ok: true, path: ZONES_POLICY_PATH, light_contracts: zones.light_contracts }, null, 2)}\n`);
    } else if (sub === 'check') {
      const files = String(args.files ?? '').split(',').map((f) => f.trim()).filter(Boolean);
      if (files.length === 0) throw new Error('zones check needs --files <a,b,...>.');
      process.stdout.write(`${JSON.stringify(classifyZone(loadZonesPolicy(repoRoot, 'HEAD'), files), null, 2)}\n`);
    } else {
      throw new Error('Usage: zones.mjs <show|set|set-light|check> --repo <path> ...');
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
