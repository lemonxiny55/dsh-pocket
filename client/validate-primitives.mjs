import { resolve } from 'node:path';
import { build } from 'esbuild';

const primitivesId = '@deepseek-ai/dsh-client-ui-primitives';

// Link against a specific host's ESM entry without executing it or writing the
// validation bundle. The host supplies CSS and other packages at runtime.
export async function validatePrimitiveExports(options, primitiveEntry) {
  const entry = resolve(primitiveEntry);
  const result = await build({
    ...options,
    write: false,
    metafile: true,
    // Keep the supplied host path stable in the metafile, including pnpm links.
    preserveSymlinks: true,
    packages: 'external',
    external: [...options.external.filter((id) => id !== primitivesId), '*.css'],
    plugins: [{
      name: 'validate-host-primitives',
      setup(build) {
        build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: entry }));
      },
    }],
  });
  // CommonJS exports cannot be checked statically by esbuild. Do not report a
  // successful check if the supplied host entry has switched module formats.
  const host = Object.entries(result.metafile.inputs).find(([path]) => resolve(path) === entry);
  if (host && host[1].format !== 'esm') {
    throw new Error(`Primitive export validation requires an ESM host entry: ${entry}`);
  }
}
