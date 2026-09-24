import type { SpawnSyncOptions } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import * as v from 'valibot';

const packageDir = path.resolve(import.meta.dirname, '..');
const workspaceDir = path.resolve(packageDir, '..', '..');

/*
 * Every workspace package, because the tarballs depend on each other by
 * version and none of those versions is on the registry. Handing npm all four
 * at once is what lets it satisfy them locally instead of trying to fetch
 * lsp-proxy-claude-code and failing the install.
 */
const workspacePackages = ['claude-code', 'config-default', 'proxy', 'registry'];

/*
 * The linter packages a .vue file needs from the project's own install.
 */
const externalPackages = ['eslint', 'eslint-plugin-vue', 'vue-eslint-parser'];

const locateTarball = (name: string): string => {
  const dir = path.join(workspaceDir, 'packages', name, 'dist', 'packages', 'npm');
  const tarballs = readdirSync(dir).filter(entry => entry.endsWith('.tgz'));
  const [only] = tarballs;
  if (only === undefined || tarballs.length !== 1) {
    throw new Error(
      `Expected exactly one tarball in ${dir}, found ${String(tarballs.length)}. ` +
      'Run `pnpm run pack` first.',
    );
  }
  return path.join(dir, only);
};

/**
 * Pin an external package to the version this workspace resolved, so a fixture
 * asks the registry for a tarball the lockfile already describes. Read from
 * the install rather than the manifest, whose specifier is a catalog
 * reference; the package's own `node_modules` holds it because this workspace
 * sets `hoist: false`.
 */
const pinned = (name: string): string => {
  const manifestPath = path.join(packageDir, 'node_modules', name, 'package.json');
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const { version } = v.parse(v.object({ version: v.string() }), parsed);
  return `${name}@${version}`;
};

/*
 * Captured rather than discarded, so a failure carries its cause: npm reports
 * one in a single line the exit code does not. 10MB is far past what an
 * install emits without a TTY, and overrunning it reports ENOBUFS, which still
 * beats silence.
 */
const maxOutputBytes = 10_000_000;
const maxOutputLines = 40;

const exec = (command: string, args: readonly string[], options: SpawnSyncOptions): void => {
  const result = spawn.sync(command, [...args], {
    ...options,
    encoding: 'utf8',
    maxBuffer: maxOutputBytes,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status === 0) return;

  const output = [result.stdout, result.stderr]
    .map(stream => stream.trim())
    .filter(stream => stream !== '')
    .join('\n')
    .split(/\r?\n/v);
  throw new Error([
    `${[command, ...args].join(' ')} exited with ${String(result.status)}`,
    '',
    ...output.slice(-maxOutputLines),
  ].join('\n'));
};

const offlineFirst = ['--prefer-offline', '--no-audit', '--no-fund'];
const revalidate = ['--prefer-online', '--no-audit', '--no-fund'];

/*
 * npm spells the same condition two ways and has changed the prefix across
 * majors, so match its diagnostic line rather than the word anywhere in the
 * output, where a package name could supply it.
 */
const staleMetadataPattern = /^npm (?:error|ERR!) (?:code ETARGET\b|notarget\b)/mv;

/**
 * Install `specs` into `cwd`, reaching the registry only if the first attempt
 * fails the way a stale packument makes it fail.
 *
 * `--prefer-offline` skips staleness checks and fetches only what is missing,
 * which is what keeps the suite's wall time off registry latency. The cost is
 * that a packument cached before a version was published reports that version
 * as nonexistent — and pinning exact versions is what exposes a fixture to it,
 * not what protects it. A dependency bump leaves the cache in exactly that
 * state, which is when these run.
 */
const npmInstall = (cwd: string, specs: readonly string[]): void => {
  try {
    exec('npm', ['install', ...specs, ...offlineFirst], { cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (staleMetadataPattern.exec(message) === null) throw error;
    exec('npm', ['install', ...specs, ...revalidate], { cwd });
  }
};

const LaunchSchema = v.object({ args: v.array(v.string()), command: v.string() });
const GeneratedPluginSchema = v.object({ 'lsp-proxy': LaunchSchema });

export interface ProjectFixture {
  /**
   * Directory the installed config package occupies, and the proxy's --config-dir.
   */
  readonly configDir: string;
  /**
   * Argv the generated .lsp.json says to launch the proxy with.
   */
  readonly launch: { readonly command: string; readonly args: readonly string[] };
  /**
   * Workspace root the language servers see, holding the .vue file.
   */
  readonly workspaceRoot: string;
  readonly [Symbol.dispose]: () => void;
}

/**
 * Install the packed tarballs into a throwaway npm project and return what is
 * needed to drive the proxy it generates. Installing rather than pointing at
 * the source tree is the whole point: it exercises the published file list,
 * the dependency versions and the postinstall hook.
 */
export const createProjectFixture = (files: Readonly<Record<string, string>>): ProjectFixture => {
  const projectDir = mkdtempSync(path.join(tmpdir(), 'lsp-proxy-e2e-'));
  const workspaceRoot = path.join(projectDir, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });

  /*
   * `--init-type module` so the flat ESLint config the fixture writes loads.
   */
  exec('npm', ['init', '--yes', '--init-type', 'module'], { cwd: projectDir });
  npmInstall(projectDir, [
    ...workspacePackages.map(name => locateTarball(name)),
    ...externalPackages.map(name => pinned(name)),
  ]);

  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(workspaceRoot, name), contents);
  }

  const configDir = path.join(projectDir, 'node_modules', 'lsp-proxy-config-default');
  const generated: unknown = JSON.parse(
    readFileSync(path.join(configDir, '.lsp.json'), 'utf8'),
  );

  /*
   * Parsed rather than asserted: this file is written by the postinstall hook
   * under test, so a shape that drifted is a result worth failing on here.
   */
  const { 'lsp-proxy': entry } = v.parse(GeneratedPluginSchema, generated);

  return {
    configDir,
    launch: { args: entry.args, command: entry.command },
    workspaceRoot,
    [Symbol.dispose]() {
      rmSync(projectDir, { force: true, recursive: true });
    },
  };
};
