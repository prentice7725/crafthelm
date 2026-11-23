import path from 'node:path';
import { isHelpRequested, isMainModule, parseArgs } from './lib/cli.mjs';
import { analyzeImpact } from './lib/impact-analysis.mjs';

function printUsage() {
  process.stdout.write(
    [
      'CraftHelm Impact CLI (AST + Call-Graph Diff Impact & Selective Test Recommendation)',
      '',
      'Usage: impact.mjs [--repo .] [--base-ref <ref>] [--analyzer-cmd "<cmd>"] [--test-command-template "<tpl>"] [--test-patterns <globs>]',
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
    const repoRoot = path.resolve(args.repo ?? '.');
    const testPatterns = args['test-patterns']
      ? String(args['test-patterns']).split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const report = analyzeImpact(repoRoot, {
      baseRef: args['base-ref'],
      customAnalyzerCmd: args['analyzer-cmd'],
      testCommandTemplate: args['test-command-template'],
      testPatterns,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
