import fs from 'node:fs';
import path from 'node:path';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { routeTask } from './lib/model-router.mjs';

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Model Router CLI (Cost-Efficient Tier Separation)',
      '',
      'Usage: route.mjs [--task-type <type>] [--prompt "<text>"] [--host <host>] [--repo .] [--impact-file <path>] [--risk <level>] [--retry-round <n>] [--single-model] [--supports-multi-model]',
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
  try {
    let impactedCount = args['impacted-files'] !== undefined ? Number(args['impacted-files']) : 0;
    if (args['impact-file'] && fs.existsSync(path.resolve(args['impact-file']))) {
      const impactJson = JSON.parse(fs.readFileSync(path.resolve(args['impact-file']), 'utf8'));
      if (Array.isArray(impactJson.impacted_files)) {
        impactedCount = impactJson.impacted_files.length;
      }
    }

    const modelTiers = {};
    if (args['lightweight-model']) modelTiers.lightweight = args['lightweight-model'];
    if (args['standard-model']) modelTiers.standard = args['standard-model'];
    if (args['reasoning-model']) modelTiers.reasoning = args['reasoning-model'];

    const decision = routeTask(
      {
        task_type: args['task-type'],
        prompt: args.prompt ?? args._[0] ?? '',
        risk_level: args.risk,
        retry_round: args['retry-round'] !== undefined ? Number(args['retry-round']) : 0,
        files_count: args.files !== undefined ? Number(args.files) : 0,
        impacted_files_count: impactedCount,
      },
      {
        host: args.host,
        repoRoot: args.repo,
        cliCommand: args.cli,
        singleModel: Boolean(args['single-model']),
        inSession: Boolean(args['in-session']),
        supportsMultiModel: Boolean(args['supports-multi-model']),
        ...(Object.keys(modelTiers).length > 0 ? { modelTiers } : {}),
      },
    );
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
