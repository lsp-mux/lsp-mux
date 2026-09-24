import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadServerConfig } from 'lsp-proxy/config';
import * as v from 'valibot';
import { it as base, describe } from 'vitest';
import { type ProjectFixture, createProjectFixture } from './fixture.ts';
import { type ProxyClient, startProxy } from './lsp-client.ts';

/*
 * A single-file component whose script block breaks a rule both linters ship.
 */
const probeComponent = `<script setup>
const items = [1, 2, 3]
debugger
</script>

<template>
  <div>{{ items.length }}</div>
</template>
`;

const eslintConfig = `import vueParser from 'vue-eslint-parser';

export default [
  {
    files: ['**/*.vue'],
    languageOptions: { parser: vueParser },
    rules: { 'no-debugger': 'warn' },
  },
];
`;

interface Fixtures {
  readonly project: ProjectFixture;
  readonly probeUri: string;
  readonly proxy: ProxyClient;
}

/*
 * Both fixtures are file-scoped: the install takes minutes and the proxy
 * starts four language servers, so each test paying for its own would trade
 * the suite's whole wall time for isolation it does not use. Nothing here
 * mutates them — the document is opened once and every test only reads what
 * the servers reported about it.
 */
/* eslint-disable-next-line vitest/consistent-test-it --
   Extending at module scope reads as a call outside describe; every use of
   the result below is the `it` the rule asks for inside one. */
const it = base.extend<Fixtures>({
  probeUri: [
    async ({ project }, use) => {
      await use(pathToFileURL(path.join(project.workspaceRoot, 'Probe.vue')).href);
    },
    { scope: 'file' },
  ],
  project: [
    async ({}, use) => {
      using project = createProjectFixture({
        'Probe.vue': probeComponent,
        'eslint.config.js': eslintConfig,
      });
      await use(project);
    },
    { scope: 'file' },
  ],
  proxy: [
    async ({ probeUri, project }, use) => {
      await using proxy = await startProxy(
        project.launch.command, project.launch.args, project.workspaceRoot,
      );
      await proxy.openDocument(probeUri, 'vue', probeComponent);
      await use(proxy);
    },
    { scope: 'file' },
  ],
});

const PluginSchema = v.object({
  languages: v.array(v.string()),
  location: v.string(),
  name: v.string(),
});

const TsserverSchema = v.object({ globalPlugins: v.array(PluginSchema) });
const VtslsSchema = v.object({ tsserver: TsserverSchema });
const VtslsSettingsSchema = v.object({ vtsls: VtslsSchema });

describe('lsp-proxy-config-default, installed from its tarball', () => {
  it('publishes the vtsls override', async ({ project, expect }) => {
    const vtsls = await loadServerConfig('vtsls', project.configDir);
    const { vtsls: settings } = v.parse(VtslsSettingsSchema, vtsls.settings);
    const [plugin] = settings.tsserver.globalPlugins;

    /*
     * servers/vtsls.json reached npm only once the copy into dist/source
     * stopped flattening it, and nothing in the source tree can tell: the
     * override loads there whether or not it was published. Reading it back
     * from an installed package is the only check that fails when it is not.
     */
    expect(vtsls.languages['vue']).toStrictEqual(['.vue']);
    expect(plugin?.name).toBe('@vue/typescript-plugin');
  });

  it('reports an oxlint diagnostic for a single-file component', async ({
    probeUri, proxy, expect,
  }) => {
    /*
     * oxlint reads the script block with no configuration of its own, so this
     * is what a .vue file gets from a default install. Matching on the source
     * keeps the two linters apart: both report the same rule name here.
     */
    const diagnostic = await proxy.waitForDiagnostic(
      probeUri, ({ source, code }) => source === 'oxc' && code === 'eslint(no-debugger)',
    );

    expect(diagnostic.message).toContain('debugger');
  });

  it('reports an ESLint diagnostic for a single-file component', async ({
    probeUri, proxy, expect,
  }) => {
    /*
     * ESLint reaches a .vue file only through the project's own flat config,
     * which the fixture gives a vue-eslint-parser block. Without the registry
     * routing .vue to the server the request never arrives and nothing is
     * reported, which is the failure this guards.
     */
    const diagnostic = await proxy.waitForDiagnostic(
      probeUri, ({ source, code }) => source === 'eslint' && code === 'no-debugger',
    );

    expect(diagnostic.message).toContain('debugger');
  });
});
