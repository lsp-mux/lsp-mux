import { access } from 'node:fs/promises';
import path from 'node:path';
import { loadProxyConfig, loadServerConfig } from 'lsp-proxy/config';
import * as v from 'valibot';
import { describe, it } from 'vitest';

const configDir = path.join(import.meta.dirname, '..');

const PluginSchema = v.object({
  enableForWorkspaceTypeScriptVersions: v.boolean(),
  languages: v.array(v.string()),
  location: v.string(),
  name: v.string(),
});

const TsserverSettingsSchema = v.object({ globalPlugins: v.array(PluginSchema) });

const VtslsSettingsSchema = v.object({
  vtsls: v.object({ tsserver: TsserverSettingsSchema }),
});

const isReadable = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

describe('lsp-proxy-config-default', () => {
  it('bridges the vue server to vtsls', async ({ expect }) => {
    const config = await loadProxyConfig(configDir);

    /*
     * Order decides routing: a request for a .vue file goes to the first
     * server claiming the language, and both of these claim it. Volar owns
     * the file, so it has to come before vtsls, which is only there to hold
     * the TypeScript project behind it.
     */
    expect(config.servers).toStrictEqual(['vue', 'vtsls', 'eslint', 'oxlint']);
    expect(config.bridges).toStrictEqual([
      { protocol: 'tsserver', from: 'vue', to: 'vtsls' },
    ]);
  });

  it('routes .vue to both the vue server and vtsls', async ({ expect }) => {
    const vue = await loadServerConfig('vue', configDir);
    const vtsls = await loadServerConfig('vtsls', configDir);

    /*
     * Volar owns the template and script blocks, and vtsls has to see the
     * same file for its tsserver to hold a project the bridged commands can
     * ask about. A .vue file reaching only one of them is the failure this
     * guards.
     */
    expect(vue.languages['vue']).toStrictEqual(['.vue']);
    expect(vtsls.languages['vue']).toStrictEqual(['.vue']);
    expect(vtsls.languages['typescript']).toContain('.ts');
  });

  it('routes .vue to both linters', async ({ expect }) => {
    const eslint = await loadServerConfig('eslint', configDir);
    const oxlint = await loadServerConfig('oxlint', configDir);

    /*
     * Both linters read the script block of a single-file component, so a
     * .vue file that reaches neither is silently unlinted — the failure this
     * guards. What each one reports past that is the user's own linter
     * config, and the README says what it takes.
     */
    expect(eslint.languages['vue']).toStrictEqual(['.vue']);
    expect(oxlint.languages['vue']).toStrictEqual(['.vue']);
  });

  it('loads the Vue plugin into tsserver from a path that exists', async ({ expect }) => {
    const vtsls = await loadServerConfig('vtsls', configDir);
    const { vtsls: settings } = v.parse(VtslsSettingsSchema, vtsls.settings);
    const [plugin] = settings.tsserver.globalPlugins;

    /*
     * vtsls drops a globalPlugins entry whose location it cannot resolve, and
     * says nothing when it does, so the commands the bridge forwards would
     * simply not exist. Assert the resolved directory is really there.
     */
    expect(plugin?.name).toBe('@vue/typescript-plugin');
    expect(plugin?.languages).toStrictEqual(['vue']);
    expect(path.isAbsolute(plugin?.location ?? '')).toBe(true);
    await expect(isReadable(plugin?.location ?? '')).resolves.toBe(true);
  });
});
