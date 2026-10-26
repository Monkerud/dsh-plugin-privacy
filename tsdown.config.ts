import { defineConfig } from 'tsdown'

const platformModules = ['react', 'react/jsx-runtime'] as const

export default defineConfig([
  {
    name: 'dsh-agent-privacy',
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    sourcemap: true,
    clean: false,
    dts: false,
    outDir: 'lib',
  },
  {
    name: 'dsh-agent-privacy/client',
    entry: { client: 'src/client/index.tsx' },
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    clean: false,
    dts: false,
    outDir: 'lib',
    external: [...platformModules],
    noExternal: (id: string) => platformModules.includes(id as (typeof platformModules)[number]) ? undefined : true,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-agent-privacy", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
