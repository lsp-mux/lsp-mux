import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { faker } from '@faker-js/faker';
import { afterAll, describe, it } from 'vitest';
import {
  FileChangeType, WatchKind, classifyChange, createExcludeMatcher, empty,
  isWithinRoot, matchEvent, register, resolveRoot,
  unregister, unregisterServer,
} from '../src/file-watcher.ts';

const serverA = faker.string.alpha(8);
const serverB = faker.string.alpha(8);
const serverUnknown = faker.string.alpha(8);
const reg1 = faker.string.uuid();
const reg2 = faker.string.uuid();
const reg3 = faker.string.uuid();
const regUnknown = faker.string.uuid();

const tsWatchers = {
  watchers: [{ globPattern: '**/*.ts', kind: WatchKind.All }],
};

const configWatchers = {
  watchers: [{ globPattern: '**/tsconfig*.json', kind: WatchKind.Change }],
};

describe('file-watcher', () => {
  describe('register / unregister', () => {
    it('registers and matches a glob pattern', ({ expect }) => {
      const state = register(empty(), serverA, reg1, tsWatchers);
      const matches = matchEvent(state, 'src/foo.ts', FileChangeType.Changed, 'file:///src/foo.ts');

      expect(matches.get(serverA)).toStrictEqual([
        { uri: 'file:///src/foo.ts', type: FileChangeType.Changed },
      ]);
    });

    it('does not match unrelated extensions', ({ expect }) => {
      const state = register(empty(), serverA, reg1, tsWatchers);
      const matches = matchEvent(state, 'src/foo.css', FileChangeType.Changed, 'file:///src/foo.css');

      expect(matches.size).toBe(0);
    });

    it('unregisters by ID', ({ expect }) => {
      const s1 = register(empty(), serverA, reg1, tsWatchers);
      const s2 = unregister(s1, reg1);
      const matches = matchEvent(s2, 'src/foo.ts', FileChangeType.Changed, 'file:///src/foo.ts');

      expect(matches.size).toBe(0);
    });

    it('unregisters all for a server', ({ expect }) => {
      let state = register(empty(), serverA, reg1, tsWatchers);
      state = register(state, serverA, reg2, configWatchers);
      state = register(state, serverB, reg3, tsWatchers);

      state = unregisterServer(state, serverA);

      expect(matchEvent(state, 'src/foo.ts', FileChangeType.Changed, 'file:///foo.ts').has(serverA)).toBe(false);
      expect(matchEvent(state, 'src/foo.ts', FileChangeType.Changed, 'file:///foo.ts').has(serverB)).toBe(true);
    });

    it('returns same state when unregistering nonexistent ID', ({ expect }) => {
      const state = register(empty(), serverA, reg1, tsWatchers);

      expect(unregister(state, regUnknown)).toBe(state);
    });

    it('returns same state when unregistering nonexistent server', ({ expect }) => {
      const state = register(empty(), serverA, reg1, tsWatchers);

      expect(unregisterServer(state, serverUnknown)).toBe(state);
    });
  });

  describe('event type filtering', () => {
    it('respects WatchKind bitmask — Change only', ({ expect }) => {
      const state = register(empty(), serverA, reg1, configWatchers);

      const changed = matchEvent(state, 'tsconfig.json', FileChangeType.Changed, 'file:///tsconfig.json');

      expect(changed.get(serverA)).toHaveLength(1);

      const created = matchEvent(state, 'tsconfig.json', FileChangeType.Created, 'file:///tsconfig.json');

      expect(created.size).toBe(0);

      const deleted = matchEvent(state, 'tsconfig.json', FileChangeType.Deleted, 'file:///tsconfig.json');

      expect(deleted.size).toBe(0);
    });

    it('respects WatchKind bitmask — Create only', ({ expect }) => {
      const state = register(empty(), serverA, reg1, {
        watchers: [{ globPattern: '**/*.ts', kind: WatchKind.Create }],
      });

      expect(matchEvent(state, 'new.ts', FileChangeType.Created, 'file:///new.ts').has(serverA)).toBe(true);
      expect(matchEvent(state, 'new.ts', FileChangeType.Changed, 'file:///new.ts').has(serverA)).toBe(false);
      expect(matchEvent(state, 'new.ts', FileChangeType.Deleted, 'file:///new.ts').has(serverA)).toBe(false);
    });

    it('respects WatchKind bitmask — Delete only', ({ expect }) => {
      const state = register(empty(), serverA, reg1, {
        watchers: [{ globPattern: '**/*.ts', kind: WatchKind.Delete }],
      });

      expect(matchEvent(state, 'old.ts', FileChangeType.Deleted, 'file:///old.ts').has(serverA)).toBe(true);
      expect(matchEvent(state, 'old.ts', FileChangeType.Created, 'file:///old.ts').has(serverA)).toBe(false);
      expect(matchEvent(state, 'old.ts', FileChangeType.Changed, 'file:///old.ts').has(serverA)).toBe(false);
    });

    it('defaults to WatchKind.All when kind is omitted', ({ expect }) => {
      const state = register(empty(), serverA, reg1, {
        watchers: [{ globPattern: '**/*.ts' }],
      });
      for (const type of [FileChangeType.Created, FileChangeType.Changed, FileChangeType.Deleted]) {
        expect(matchEvent(state, 'foo.ts', type, 'file:///foo.ts').has(serverA)).toBe(true);
      }
    });

    it('matches all event types with WatchKind.All', ({ expect }) => {
      const state = register(empty(), serverA, reg1, tsWatchers);

      for (const type of [FileChangeType.Created, FileChangeType.Changed, FileChangeType.Deleted]) {
        const matches = matchEvent(state, 'foo.ts', type, 'file:///foo.ts');

        expect(matches.get(serverA)).toHaveLength(1);
      }
    });

    it('matches via second registration when first does not match kind', ({ expect }) => {
      let state = register(empty(), serverA, reg1, {
        watchers: [{ globPattern: '**/*.ts', kind: WatchKind.Create }],
      });
      state = register(state, serverA, reg2, {
        watchers: [{ globPattern: '**/*.ts', kind: WatchKind.Change }],
      });

      // Changed event should match via reg2 even though reg1 didn't match
      const matches = matchEvent(state, 'foo.ts', FileChangeType.Changed, 'file:///foo.ts');

      expect(matches.has(serverA)).toBe(true);
    });
  });

  describe('multi-server matching', () => {
    it('matches same event to multiple servers', ({ expect }) => {
      let state = register(empty(), serverA, reg1, tsWatchers);
      state = register(state, serverB, reg2, tsWatchers);

      const matches = matchEvent(state, 'src/index.ts', FileChangeType.Changed, 'file:///src/index.ts');

      expect(matches.get(serverA)).toHaveLength(1);
      expect(matches.get(serverB)).toHaveLength(1);
    });
  });

  describe('deduplication', () => {
    it('deduplicates events per-server across multiple registrations', ({ expect }) => {
      let state = register(empty(), serverA, reg1, tsWatchers);
      state = register(state, serverA, reg2, {
        watchers: [{ globPattern: '**/*.{ts,js}', kind: WatchKind.All }],
      });

      const matches = matchEvent(state, 'src/foo.ts', FileChangeType.Changed, 'file:///src/foo.ts');

      // Should be exactly 1, not 2 — both registrations match but same server
      expect(matches.get(serverA)).toHaveLength(1);
    });

    it('still matches different servers independently', ({ expect }) => {
      let state = register(empty(), serverA, reg1, tsWatchers);
      state = register(state, serverB, reg2, tsWatchers);

      const matches = matchEvent(state, 'src/foo.ts', FileChangeType.Changed, 'file:///src/foo.ts');

      expect(matches.get(serverA)).toHaveLength(1);
      expect(matches.get(serverB)).toHaveLength(1);
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
      const state = register(empty(), serverA, reg1, {
        watchers: [{
          globPattern: { baseUri: 'src', pattern: '**/*.ts' },
          kind: WatchKind.All,
        }],
      });

      const matches = matchEvent(state, 'src/components/App.ts', FileChangeType.Changed, 'file:///src/components/App.ts');

      expect(matches.get(serverA)).toHaveLength(1);

      const noMatch = matchEvent(state, 'test/foo.ts', FileChangeType.Changed, 'file:///test/foo.ts');

      expect(noMatch.size).toBe(0);
    });

    it('resolves file:// URI baseUri to workspace-relative path', ({ expect }) => {
      const workspaceRoot = process.platform === 'win32' ? String.raw`C:\projects\my-app` : '/projects/my-app';
      const baseUri = process.platform === 'win32'
        ? 'file:///C:/projects/my-app/src'
        : 'file:///projects/my-app/src';

      const state = register(empty(), serverA, reg1, {
        watchers: [{
          globPattern: { baseUri, pattern: '**/*.ts' },
          kind: WatchKind.All,
        }],
      }, workspaceRoot);

      const matches = matchEvent(state, 'src/components/App.ts', FileChangeType.Changed, 'file:///src/components/App.ts');

      expect(matches.get(serverA)).toHaveLength(1);

      const noMatch = matchEvent(state, 'lib/foo.ts', FileChangeType.Changed, 'file:///lib/foo.ts');

      expect(noMatch.size).toBe(0);
    });

    it('handles WorkspaceFolder object as baseUri', ({ expect }) => {
      const workspaceRoot = process.platform === 'win32' ? String.raw`C:\projects\app` : '/projects/app';
      const baseUri = process.platform === 'win32'
        ? 'file:///C:/projects/app/src'
        : 'file:///projects/app/src';

      const state = register(empty(), serverA, reg1, {
        watchers: [{
          globPattern: { baseUri: { uri: baseUri, name: 'app' }, pattern: '**/*.ts' },
          kind: WatchKind.All,
        }],
      }, workspaceRoot);

      const matches = matchEvent(state, 'src/components/App.ts', FileChangeType.Changed, 'file:///src/components/App.ts');

      expect(matches.get(serverA)).toHaveLength(1);

      const noMatch = matchEvent(state, 'lib/foo.ts', FileChangeType.Changed, 'file:///lib/foo.ts');

      expect(noMatch.size).toBe(0);
    });

    it('strips trailing slash from baseUri', ({ expect }) => {
      const state = register(empty(), serverA, reg1, {
        watchers: [{
          globPattern: { baseUri: 'src/', pattern: '*.ts' },
          kind: WatchKind.All,
        }],
      });

      const matches = matchEvent(state, 'src/index.ts', FileChangeType.Changed, 'file:///src/index.ts');

      expect(matches.get(serverA)).toHaveLength(1);
    });
  });

  describe('isWithinRoot', () => {
    // Tests use non-existent paths, so resolveRoot falls back to path.resolve.
    // Pre-resolve to match what the proxy does at startup.
    const root = path.resolve('/workspace');

    it('accepts paths within root', async ({ expect }) => {
      await expect(isWithinRoot('/workspace/src/foo.ts', root)).resolves.toBe(true);
    });

    it('rejects paths that escape via ..', async ({ expect }) => {
      await expect(isWithinRoot('/workspace/../etc/passwd', root)).resolves.toBe(false);
    });

    it('accepts the root path itself', async ({ expect }) => {
      await expect(isWithinRoot('/workspace', root)).resolves.toBe(true);
    });

    it('rejects a sibling directory', async ({ expect }) => {
      await expect(isWithinRoot('/other/foo.ts', root)).resolves.toBe(false);
    });

    it('rejects a prefix that is not a directory boundary', async ({ expect }) => {
      // /workspace-evil is not inside /workspace
      await expect(isWithinRoot('/workspace-evil/foo.ts', root)).resolves.toBe(false);
    });
  });

  // Sequential: tests share a temp dir created by setup()
  describe.sequential('isWithinRoot with symlinked workspace root', () => {
    let tmpBase: string;
    let realDir: string;
    let linkDir: string;

    afterAll(async () => {
      if (tmpBase) {
        try {
          await rm(tmpBase, { recursive: true, force: true });
        } catch { /* cleanup */ }
      }
    });

    // Create a real directory with a symlink pointing to it.
    // resolveRoot on the symlink follows it to the real path.
    // Delete events inside the symlink namespace must still pass
    // the containment check even though the file doesn't exist.
    const setup = async () => {
      tmpBase = await mkdtemp(path.join(tmpdir(), 'fw-symlink-'));
      realDir = path.join(tmpBase, 'real-workspace');
      linkDir = path.join(tmpBase, 'link-workspace');
      await mkdir(realDir, { recursive: true });
      await symlink(realDir, linkDir, 'junction');
      // Create a file so we can also test the existing-file path
      await writeFile(path.join(realDir, 'existing.ts'), '');
    };

    it('resolveRoot follows the symlink to the real path', async ({ expect }) => {
      await setup();
      const resolved = await resolveRoot(linkDir);

      expect(resolved).toBe(path.resolve(realDir));
    });

    it('accepts existing files inside symlinked root', async ({ expect }) => {
      await setup();
      const resolved = await resolveRoot(linkDir);

      // Existing file accessed via symlink — realpath resolves to real path
      await expect(isWithinRoot(path.join(linkDir, 'existing.ts'), resolved)).resolves.toBe(true);
    });

    it('accepts non-existent files inside symlinked root (delete events)', async ({ expect }) => {
      await setup();
      const resolved = await resolveRoot(linkDir);

      // Non-existent file — resolve() fallback uses symlink namespace.
      // Must still pass containment check against realpath-resolved root.
      await expect(isWithinRoot(path.join(linkDir, 'deleted.ts'), resolved)).resolves.toBe(true);
    });

    it('rejects non-existent files outside symlinked root', async ({ expect }) => {
      await setup();
      const resolved = await resolveRoot(linkDir);

      await expect(isWithinRoot(path.join(tmpBase, 'outside.ts'), resolved)).resolves.toBe(false);
    });
  });
});
