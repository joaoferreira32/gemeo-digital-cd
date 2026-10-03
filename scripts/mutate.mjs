/**
 * Mutation check that never touches the files you are working on.
 *
 *   npm run mutate                              (every spec in mutations/)
 *   npm run mutate -- mutations/vigia.json [mutations/outro.json …]
 *
 * The working tree (committed and uncommitted files, as `git ls-files`
 * sees them) is copied to a temporary folder, with node_modules linked, and
 * every mutation is applied to that copy only: if the run is interrupted,
 * the worst that can happen is a stray folder in the system temp dir. At the
 * end the copy is deleted and the real tree is compared with how it was
 * before (git status and git diff), and any difference is an error.
 *
 * A spec lists the tests to run and the mutations; each mutation replaces
 * exact snippets (each must occur exactly once). A mutation the tests cannot
 * tell apart from the original can be marked "equivalent" with a reason.
 *
 *   { "tests": ["tests/x.test.ts"],
 *     "mutations": [{ "name": "…", "edits": [{ "file": "src/…", "find": "…", "replace": "…" }],
 *                     "equivalent": "optional reason" }] }
 *
 * Exit code 1 when a mutation survives (and is not marked equivalent), when a
 * snippet is not found, or when the baseline fails.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);
const specs = process.argv.slice(2);
if (specs.length === 0) {
  for (const name of readdirSync(join(root, 'mutations')).sort()) {
    if (name.endsWith('.json')) specs.push(`mutations/${name}`);
  }
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const treeState = () =>
  createHash('sha256')
    .update(git('status', '--porcelain', '--untracked-files=all'))
    .update(git('diff', 'HEAD'))
    .digest('hex');
const before = treeState();

// Copies left by an interrupted run (older than an hour, so a run going on in
// parallel keeps its own).
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith('gemeo-mutate-')) continue;
  const path = join(tmpdir(), name);
  if (Date.now() - statSync(path).mtimeMs > 3600_000)
    rmSync(path, { recursive: true, force: true });
}

const copy = mkdtempSync(join(tmpdir(), 'gemeo-mutate-'));
let failed = false;
try {
  const files = git('ls-files', '-co', '--exclude-standard', '-z').split('\0').filter(Boolean);
  for (const f of files) {
    const to = join(copy, f);
    mkdirSync(dirname(to), { recursive: true });
    try {
      copyFileSync(join(root, f), to);
    } catch {
      // Listed but deleted in the working tree: not part of it.
    }
  }
  symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'junction');
  console.log(`cópia temporária: ${copy} (${files.length} arquivos)\n`);

  const vitest = (tests) =>
    spawnSync(process.execPath, [join(copy, 'node_modules/vitest/vitest.mjs'), 'run', ...tests], {
      cwd: copy,
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
    });

  for (const specPath of specs) {
    const spec = JSON.parse(readFileSync(resolve(root, specPath), 'utf8'));
    console.log(
      `== ${specPath}: ${spec.mutations.length} mutações, testes ${spec.tests.join(' ')}`,
    );
    const base = vitest(spec.tests);
    if (base.status !== 0) {
      console.log('  a linha de base (sem mutação) já falha: nada a conferir');
      console.log(base.stdout.slice(-2000));
      failed = true;
      continue;
    }
    let caught = 0;
    let equivalent = 0;
    for (const m of spec.mutations) {
      const originals = new Map();
      let missing = '';
      for (const e of m.edits) {
        const path = join(copy, e.file);
        const text = originals.get(path) ?? readFileSync(path, 'utf8');
        if (!originals.has(path)) originals.set(path, text);
        const current = readFileSync(path, 'utf8');
        const count = current.split(e.find).length - 1;
        if (count !== 1) {
          missing = `${e.file}: trecho encontrado ${count} vezes`;
          break;
        }
        writeFileSync(path, current.replace(e.find, e.replace));
      }
      let verdict;
      if (missing) {
        verdict = `?? não aplicada (${missing})`;
        failed = true;
      } else {
        const run = vitest(spec.tests);
        const names = (run.stdout + run.stderr)
          .split('\n')
          .filter((l) => l.trim().startsWith('×'))
          .map((l) =>
            l
              .trim()
              .replace(/^× /, '')
              .replace(/ \d+ms$/, ''),
          );
        if (run.status !== 0) {
          caught++;
          verdict = `PEGA   ${names.length} teste(s) falharam${names[0] ? `: ${names[0].slice(0, 90)}` : ''}`;
        } else if (m.equivalent) {
          equivalent++;
          verdict = `EQUIV. ${m.equivalent}`;
        } else {
          verdict = 'VIVA   nenhum teste percebeu';
          failed = true;
        }
      }
      for (const [path, text] of originals) writeFileSync(path, text);
      console.log(`  ${verdict}  ← ${m.name}`);
    }
    const counted = spec.mutations.length - equivalent;
    console.log(
      `  ${caught} de ${counted} pegas${equivalent ? ` (${equivalent} equivalentes)` : ''}\n`,
    );
  }
} finally {
  // Removes the node_modules junction itself, not the folder it points to
  // (checked on Windows: the real dependencies stay untouched).
  rmSync(copy, { recursive: true, force: true });
}

if (treeState() !== before) {
  console.error('A árvore de trabalho mudou durante a execução: confira git status e git diff.');
  process.exit(1);
}
console.log('Árvore de trabalho intacta (git status e git diff iguais aos do início).');
process.exit(failed ? 1 : 0);
