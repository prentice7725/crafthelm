import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import {
  listDecisions,
  rebuildMemoryIndex,
  recordDecision,
  searchMemory,
} from './lib/memory.mjs';

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Memory CLI (Markdown SOT + node:sqlite FTS5 derived index)',
      '',
      'Usage:',
      '  memory.mjs index  [--repo .] [--docs-dir docs]',
      '  memory.mjs search --query "<terms>" [--repo .] [--kind <kind>] [--include-superseded] [--limit 10] [--half-life-days 30]',
      '  memory.mjs decide --title "<title>" [--id DEC-001] [--body "<text>"] [--supersedes DEC-000] [--task-id CH-T001] [--tags a,b] [--repo .]',
      '  memory.mjs list   [--repo .] [--include-superseded]',
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
  const sub = args._[0];

  try {
    if (!sub) {
      printUsage();
      process.exit(0);
    }

    let out;
    if (sub === 'index' || sub === 'rebuild') {
      out = rebuildMemoryIndex({ repo: args.repo, docsDir: args['docs-dir'] });
    } else if (sub === 'search') {
      out = searchMemory({
        repo: args.repo,
        query: args.query ?? args._[1] ?? '',
        kind: args.kind,
        includeSuperseded: Boolean(args['include-superseded']),
        limit: args.limit !== undefined ? Number(args.limit) : 10,
        halfLifeDays: args['half-life-days'] !== undefined ? Number(args['half-life-days']) : undefined,
        rebuild: Boolean(args.rebuild),
      });
    } else if (sub === 'decide') {
      out = recordDecision({
        repo: args.repo,
        id: args.id,
        title: args.title,
        body: args.body ?? args.rationale,
        supersedes: args.supersedes,
        taskId: args['task-id'],
        tags: args.tags,
        docsDir: args['docs-dir'],
      });
    } else if (sub === 'list') {
      const decisions = listDecisions({
        repo: args.repo,
        includeSuperseded: Boolean(args['include-superseded']),
      });
      out = { ok: true, count: decisions.length, decisions };
    } else {
      throw new Error(`Unknown memory subcommand "${sub}". Expected: index | search | decide | list`);
    }

    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
