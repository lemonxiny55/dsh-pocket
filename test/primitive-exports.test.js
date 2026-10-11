import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { build } from 'esbuild';
import { validatePrimitiveExports } from '../client/validate-primitives.mjs';

const primitivesId = '@deepseek-ai/dsh-client-ui-primitives';
const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t, client, host) {
  const dir = await mkdtemp(join(tmpdir(), 'pocket-primitives-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = join(dir, 'host.mjs');
  const clientEntry = join(dir, 'client.tsx');
  await writeFile(entry, host);
  await writeFile(clientEntry, client);
  return {
    dir,
    entry,
    options: {
      entryPoints: [clientEntry], bundle: true, format: 'cjs', platform: 'browser',
      external: ['react', 'react/jsx-runtime', primitivesId], write: false, logLevel: 'silent',
    },
  };
}

test('external build accepts a missing icon; validation rejects its original name even when aliased', async (t) => {
  const { options, entry } = await fixture(t, `
    // import { IconIgnored } from '${primitivesId}'
    import {
      IconPanelLeftOutline16 as Toggle,
      type IconProps,
    } from '${primitivesId}';
    export const render = (props: IconProps) => <Toggle {...props} />;
  `, 'export const IconPanelLeftOutlineRegular = () => null;');
  await build(options); // Reproduces #161: external bypasses export checking.
  await assert.rejects(validatePrimitiveExports(options, entry), (error) => {
    assert.ok(error.errors.some(({ text }) => /No matching export.*IconPanelLeftOutline16/.test(text)));
    return true;
  });
});

test('legacy exports validate without bundling host code into the final client', async (t) => {
  const { options, entry } = await fixture(t,
    `import { IconPanelLeftOutline16 } from '${primitivesId}'; export { IconPanelLeftOutline16 };`,
    `throw new Error('HOST_MUST_NOT_EXECUTE'); export const IconPanelLeftOutline16 = () => 'HOST_IMPLEMENTATION';`);
  await validatePrimitiveExports(options, entry);
  const result = await build(options);
  assert.match(result.outputFiles[0].text, /require\("@deepseek-ai\/dsh-client-ui-primitives"\)/);
  assert.doesNotMatch(result.outputFiles[0].text, /HOST_IMPLEMENTATION|HOST_MUST_NOT_EXECUTE/);
});

test('local ESM re-exports work without installing host dependencies or CSS', async (t) => {
  const { options, entry, dir } = await fixture(t,
    `import { IconExample as Icon } from '${primitivesId}'; export { Icon };`,
    `import './absent.module.css'; import 'absent-host-dependency'; export { IconExample } from './icons.mjs';`);
  await writeFile(join(dir, 'icons.mjs'), 'export const IconExample = () => null;');
  await validatePrimitiveExports(options, entry);
  await writeFile(join(dir, 'icons.mjs'), 'export const OtherIcon = () => null;');
  await assert.rejects(validatePrimitiveExports(options, entry), /No matching export.*IconExample/);
});

test('type-only imports and namespace compatibility lookups are not treated as required exports', async (t) => {
  const { options, entry } = await fixture(t, `
    import type { IconProps } from '${primitivesId}';
    import * as primitives from '${primitivesId}';
    export const resolve = (name: string): unknown => primitives[name];
  `, 'export const IconModern = () => null;');
  await validatePrimitiveExports(options, entry);
  // With only type imports, esbuild removes the host from the runtime graph.
  const types = await fixture(t,
    `import type { IconProps } from '${primitivesId}'; export type Props = IconProps;`,
    'export const IconModern = () => null;');
  await validatePrimitiveExports(types.options, types.entry);
});

test('invalid paths and CommonJS entries do not silently pass validation', async (t) => {
  const { options, dir } = await fixture(t,
    `import * as primitives from '${primitivesId}'; export { primitives };`,
    'module.exports = { IconExample: () => null };');
  const entry = join(dir, 'host.cjs');
  await writeFile(entry, 'module.exports = { IconExample: () => null };');
  await assert.rejects(validatePrimitiveExports(options, entry), /requires an ESM host entry/);
  await assert.rejects(validatePrimitiveExports(options, join(dir, 'missing.mjs')), /Cannot read|Could not resolve/);
});

test('build script works without a host, keeps it external when validated, and preserves output on failure', async (t) => {
  // Keep the copied build script under node_modules so it can resolve esbuild,
  // while all source/output writes are isolated from the real client bundle.
  const dir = await mkdtemp(join(packageRoot, 'node_modules', 'pocket-build-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clientDir = join(dir, 'client');
  await mkdir(clientDir);
  for (const file of ['build.mjs', 'validate-primitives.mjs']) {
    await copyFile(join(packageRoot, 'client', file), join(clientDir, file));
  }
  await writeFile(join(clientDir, 'index.jsx'),
    `import { IconExample } from '${primitivesId}'; export { IconExample };`);
  const env = { ...process.env, NODE_ENV: 'development', DSH_POCKET_CLIENT_ID: 'dsh-pocket' };
  delete env.DSH_POCKET_PRIMITIVES_ENTRY;
  await run(process.execPath, ['client/build.mjs'], { cwd: dir, env });
  const bundlePath = join(clientDir, 'client.js');
  const before = await readFile(bundlePath);
  assert.match(before.toString(), /require\("@deepseek-ai\/dsh-client-ui-primitives"\)/);
  const entry = join(dir, 'host.mjs');
  await writeFile(entry, `export const IconExample = () => 'HOST_IMPLEMENTATION';`);
  env.DSH_POCKET_PRIMITIVES_ENTRY = entry;
  await run(process.execPath, ['client/build.mjs'], { cwd: dir, env });
  assert.deepEqual(await readFile(bundlePath), before);
  await writeFile(entry, 'export const UnrelatedIcon = () => null;');
  await assert.rejects(run(process.execPath, ['client/build.mjs'], {
    cwd: dir, env,
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /No matching export/);
    return true;
  });
  assert.deepEqual(await readFile(bundlePath), before);
});
