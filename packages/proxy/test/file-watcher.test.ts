import { mkdtemp, symlink, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, afterAll } from 'vitest';
import {
  empty, register, unregister, unregisterServer, matchEvent,
  classifyChange, createExcludeMatcher, resolveRoot, isWithinRoot,
  FileChangeType, WatchKind,
} from '../src/file-watcher.js';
import { faker } from '@faker-js/faker';

const SERVER_A = faker.string.alpha(8);
const SERVER_B = faker.string.alpha(8);
const SERVER_UNKNOWN = faker.string.alpha(8);
const REG_1 = faker.string.uuid();
const REG_2 = faker.string.uuid();
const REG_3 = faker.string.uuid();
const REG_UNKNOWN = faker.string.uuid();

const tsWatchers = {
  watchers: [{ globPattern: '**/*.ts', kind: WatchKind.All }],
};

const configWatchers = {
  watchers: [{ globPattern: '**/tsconfig*.json', kind: WatchKind.Change }],
};

describe('file-watcher', () => {
  describe('register / unregister', () => {
    it('registers and matches a glob pattern', ({ expect }) => {
      const state = register(empty(), SERVER_A, REG_1, tsWatchers);
      const matches = matchEvent(state, 'src/foo.ts', FileChangeType.Changed, 'file:///src/foo.ts');
      expect(matches.get(SERVER_A)).toStrictEqual([
        { uri: 'file:///src/foo.ts', type: FileChangeType.Changed },
      ]);
    });

    it('does not match unrelated extensions', ({ expect }) => {
      const state = register(empty(), SERVER_A, REG_1, tsWatchers);
      const matches = matchEvent(state, 'src/foo.css', FileChangeType.Changed, 'file:///src/foo.css');
      expect(matches.size).toBe(0);
    });

    it('unregisters by ID', ({ expect }) => {
      const s1 = register(empty(), SERVER_A, REG_1, tsWatchers);
      const s2 = unregister(s1, REG_1);
      const matches = matchEvent(s2, 'src/foo.ts', FileChangeType.Changed, 'file:///src/foo.ts');
      expect(matches.size).toBe(0);
    });

    it('unregisters all for a server', ({ expect }) => {
      let state = register(empty(), SERVER_A, REG_1, tsWatchers);
      state = register(state, SERVER_A, REG_2, configWatchers);
      state = register(state, SERVER_B, REG_3, tsWatchers);

      state = unregisterServer(state, SERVER_A);

      expect(matchEvent(state, 'src/foo.ts', FileChangeType.Changed, 'file:///foo.ts').has(SERVER_A)).toBe(false);
      expect(matchEvent(state, 'src/foo.ts', FileChangeType.Changed, 'file:///foo.ts').has(SERVER_B)).toBe(true);
    });

    it('returns same state when unregistering nonexistent ID', ({ expect }) => {
      const state = register(empty(), SERVER_A, REG_1, tsWatchers);
      expect(unregister(state, REG_UNKNOWN)).toBe(state);
    });

    it('returns same state when unregistering nonexistent server', ({ expect }) => {
      const state = register(empty(), SERVER_A, REG_1, tsWatchers);
      expect(unregisterServer(state, SERVER_UNKNOWN)).toBe(state);
    });
  });

  describe('event type filtering', () => {
    it('respects WatchKind bitmask — Change only', ({ expect }) => {
      const state = register(empty(), SERVER_A, REG_1, configWatchers);

      const changed = matchEvent(state, 'tsconfig.json', FileChangeType.Changed, 'file:///tsconfig.json');
      expect(changed.get(SERVER_A)).toHaveLength(1);

      const created = matchEvent(state, 'tsconfig.json', FileChangeType.Created, 'file:///tsconfig.json');
      expect(created.size).toBe(0);

      const deleted = matchEvent(state, 'tsconfig.json', FileChangeType.Deleted, 'file:///tsconfig.json');
      expect(deleted.size).toBe(0);
    });

    it('respects WatchKind bitmask — Create only', ({ expect }) => {
      const state = register(empty(), SERVER_A, REG_1, {
        watchers: [{ globPattern: '**/*.ts', kind: WatchKind.Create }],
      });
      expect(matchEvent(state, 'new.ts', FileChangeType.Created, 'file:///new.ts').has(SERVER_A)).toBe(true);
      expect(matchEvent(state, 'new.ts', FileChangeType.Changed, 'file:///new.ts').has(SERVER_A)).toBe(false);
      expect(matchEvent(state, 'new.ts', FileChangeType.Deleted, 'file:///new.ts').has(SERVER_A)).toBe(false);
    });

    it('respects WatchKind bitmask — Delete only', ({ expect }) => {
      const state = register(empty(), SERVER_A, REG_1, {
        watchers: [{ globPattern: '**/*.ts', kind: WatchKind.Delete }],
      });
      expect(matchEvent(state, 'old.ts', FileChangeType.Deleted, 'file:///old.ts').has(SERVER_A)).toBe(true);
      expect(matchEvent(state, 'old.ts', FileChangeType.Created, 'file:///old.ts').has(SERVER_A)).toBe(false);
      expect(matchEvent(state, 'old.ts', FileChangeType.Changed, 'file:///old.ts').has(SERVER_A)).toBe(false);
    });

    it('defaults to WatchKind.All when kind is omitted', ({ expect }) => {
      const state = register(empty(), SERVER_A, REG_1, {
        watchers: [{ globPattern: '**/*.ts' }],
      });
      for (const type of [FileChangeType.Created, FileChangeType.Changed, FileChangeType.Deleted]) {
        expect(matchEvent(state, 'foo.ts', type, 'file:///foo.ts').has(SERVER_A)).toBe(true);
      }
    });

    it('matches all event types with WatchKind.All', ({ expect }) => {
      const state = register(empty(), SERVER_A, REG_1, tsWatchers);

      for (const type of [FileChangeType.Created, FileChangeType.Changed, FileChangeType.Deleted]) {
        const matches = matchEvent(state, 'foo.ts', type, 'file:///foo.ts');
        expect(matches.get(SERVER_A)).toHaveLength(1);
      }
    });

    it('matches via second registration when first does not match kind', ({ expect }) => {
      let state = register(empty(), SERVER_A, REG_1, {
        watchers: [{ globPattern: '**/*.ts', kind: WatchKind.Create }],
      });
      state = register(state, SERVER_A, REG_2, {
        watchers: [{ globPattern: '**/*.ts', kind: WatchKind.Change }],
      });

      // Changed event should match via REG_2 even though REG_1 didn't match
      const matches = matchEvent(state, 'foo.ts', FileChangeType.Changed, 'file:///foo.ts');
      expect(matches.has(SERVER_A)).toBe(true);
    });
  });

  describe('multi-server matching', () => {
    it('matches same event to multiple servers', ({ expect }) => {
      let state = register(empty(), SERVER_A, REG_1, tsWatchers);
      state = register(state, SERVER_B, REG_2, tsWatchers);

      const matches = matchEvent(state, 'src/index.ts', FileChangeType.Changed, 'file:///src/index.ts');
      expect(matches.get(SERVER_A)).toHaveLength(1);
      expect(matches.get(SERVER_B)).toHaveLength(1);
    });
  });

  describe('deduplication', () => {
    it('deduplicates events per-server across multiple registrations', ({ expect }) => {
      let state = register(empty(), SERVER_A, REG_1, tsWatchers);
      state = register(state, SERVER_A, REG_2, {
        watchers: [{ globPattern: '**/*.{ts,js}', kind: WatchKind.All }],
      });

      const matches = matchEvent(state, 'src/foo.ts', FileChangeType.Changed, 'file:///src/foo.ts');
      // Should be exactly 1, not 2 — both registrations match but same server
      expect(matches.get(SERVER_A)).toHaveLength(1);
    });

    it('still matches different servers independently', ({ expect }) => {
      let state = register(empty(), SERVER_A, REG_1, tsWatchers);
      state = register(state, SERVER_B, REG_2, tsWatchers);

      const matches = matchEvent(state, 'src/foo.ts', FileChangeType.Changed, 'file:///src/foo.ts');
      expect(matches.get(SERVER_A)).toHaveLength(1);
      expect(matches.get(SERVER_B)).toHaveLength(1);
    });
  });

  describe('createExcludeMatcher', () => {
    it('matches excluded patterns', ({ expect }) => {
      const isExcluded = createExcludeMatcher(['**/node_modules/**', '**/.git/**']);
      expect(isExcluded('node_modules/foo/bar.js')).toBe(true);
      expect(isExcluded('.git/objects/abc')).toBe(true);
      expect(isExcluded('src/index.ts')).toBe(false);
    });

    it('returns always-false for empty patterns', ({ expect }) => {
      const isExcluded = createExcludeMatcher([]);
      expect(isExcluded('anything')).toBe(false);
    });
  });

  describe('classifyChange', () => {
    it('classifies exists as Changed', ({ expect }) => {
      expect(classifyChange(true)).toBe(FileChangeType.Changed);
    });

    it('classifies !exists as Deleted', ({ expect }) => {
      expect(classifyChange(false)).toBe(FileChangeType.Deleted);
    });
  });

  describe('relative patterns', () => {
    it('handles { baseUri, pattern } glob with bare directory', ({ expect }) => {
      const state = register(empty(), SERVER_A, REG_1, {
        watchers: [{
          globPattern: { baseUri: 'src', pattern: '**/*.ts' },
          kind: WatchKind.All,
        }],
      });

      const matches = matchEvent(state, 'src/components/App.ts', FileChangeType.Changed, 'file:///src/components/App.ts');
      expect(matches.get(SERVER_A)).toHaveLength(1);

      const noMatch = matchEvent(state, 'test/foo.ts', FileChangeType.Changed, 'file:///test/foo.ts');
      expect(noMatch.size).toBe(0);
    });

    it('resolves file:// URI baseUri to workspace-relative path', ({ expect }) => {
      const workspaceRoot = process.platform === 'win32' ? 'C:\\projects\\my-app' : '/projects/my-app';
      const baseUri = process.platform === 'win32'
        ? 'file:///C:/projects/my-app/src'
        : 'file:///projects/my-app/src';

      const state = register(empty(), SERVER_A, REG_1, {
        watchers: [{
          globPattern: { baseUri, pattern: '**/*.ts' },
          kind: WatchKind.All,
        }],
      }, workspaceRoot);

      const matches = matchEvent(state, 'src/components/App.ts', FileChangeType.Changed, 'file:///src/components/App.ts');
      expect(matches.get(SERVER_A)).toHaveLength(1);

      const noMatch = matchEvent(state, 'lib/foo.ts', FileChangeType.Changed, 'file:///lib/foo.ts');
      expect(noMatch.size).toBe(0);
    });

    it('handles WorkspaceFolder object as baseUri', ({ expect }) => {
      const workspaceRoot = process.platform === 'win32' ? 'C:\\projects\\app' : '/projects/app';
      const baseUri = process.platform === 'win32'
        ? 'file:///C:/projects/app/src'
        : 'file:///projects/app/src';

      const state = register(empty(), SERVER_A, REG_1, {
        watchers: [{
          globPattern: { baseUri: { uri: baseUri, name: 'app' }, pattern: '**/*.ts' },
          kind: WatchKind.All,
        }],
      }, workspaceRoot);

      const matches = matchEvent(state, 'src/components/App.ts', FileChangeType.Changed, 'file:///src/components/App.ts');
      expect(matches.get(SERVER_A)).toHaveLength(1);

      const noMatch = matchEvent(state, 'lib/foo.ts', FileChangeType.Changed, 'file:///lib/foo.ts');
      expect(noMatch.size).toBe(0);
    });

    it('strips trailing slash from baseUri', ({ expect }) => {
      const state = register(empty(), SERVER_A, REG_1, {
        watchers: [{
          globPattern: { baseUri: 'src/', pattern: '*.ts' },
          kind: WatchKind.All,
        }],
      });

      const matches = matchEvent(state, 'src/index.ts', FileChangeType.Changed, 'file:///src/index.ts');
      expect(matches.get(SERVER_A)).toHaveLength(1);
    });
  });

  describe('isWithinRoot', () => {
    // Tests use non-existent paths, so resolveRoot falls back to path.resolve.
    // Pre-resolve to match what the proxy does at startup.
    const root = resolve('/workspace');

    it('accepts paths within root', async ({ expect }) => {
      expect(await isWithinRoot('/workspace/src/foo.ts', root)).toBe(true);
    });

    it('rejects paths that escape via ..', async ({ expect }) => {
      expect(await isWithinRoot('/workspace/../etc/passwd', root)).toBe(false);
    });

    it('accepts the root path itself', async ({ expect }) => {
      expect(await isWithinRoot('/workspace', root)).toBe(true);
    });

    it('rejects a sibling directory', async ({ expect }) => {
      expect(await isWithinRoot('/other/foo.ts', root)).toBe(false);
    });

    it('rejects a prefix that is not a directory boundary', async ({ expect }) => {
      // /workspace-evil is not inside /workspace
      expect(await isWithinRoot('/workspace-evil/foo.ts', root)).toBe(false);
    });
  });

  // Sequential: tests share a temp dir created by setup()
  describe.sequential('isWithinRoot with symlinked workspace root', () => {
    let tmpBase: string;
    let realDir: string;
    let linkDir: string;

    afterAll(async () => {
      if (tmpBase) {
        await rm(tmpBase, { recursive: true, force: true }).catch(() => { /* cleanup */ });
      }
    });

    // Create a real directory with a symlink pointing to it.
    // resolveRoot on the symlink follows it to the real path.
    // Delete events inside the symlink namespace must still pass
    // the containment check even though the file doesn't exist.
    const setup = async () => {
      tmpBase = await mkdtemp(join(tmpdir(), 'fw-symlink-'));
      realDir = join(tmpBase, 'real-workspace');
      linkDir = join(tmpBase, 'link-workspace');
      await mkdir(realDir, { recursive: true });
      await symlink(realDir, linkDir, 'junction');
      // Create a file so we can also test the existing-file path
      await writeFile(join(realDir, 'existing.ts'), '');
    };

    it('resolveRoot follows the symlink to the real path', async ({ expect }) => {
      await setup();
      const resolved = await resolveRoot(linkDir);
      expect(resolved).toBe(resolve(realDir));
    });

    it('accepts existing files inside symlinked root', async ({ expect }) => {
      await setup();
      const resolved = await resolveRoot(linkDir);
      // Existing file accessed via symlink — realpath resolves to real path
      expect(await isWithinRoot(join(linkDir, 'existing.ts'), resolved)).toBe(true);
    });

    it('accepts non-existent files inside symlinked root (delete events)', async ({ expect }) => {
      await setup();
      const resolved = await resolveRoot(linkDir);
      // Non-existent file — resolve() fallback uses symlink namespace.
      // Must still pass containment check against realpath-resolved root.
      expect(await isWithinRoot(join(linkDir, 'deleted.ts'), resolved)).toBe(true);
    });

    it('rejects non-existent files outside symlinked root', async ({ expect }) => {
      await setup();
      const resolved = await resolveRoot(linkDir);
      expect(await isWithinRoot(join(tmpBase, 'outside.ts'), resolved)).toBe(false);
    });
  });
});
