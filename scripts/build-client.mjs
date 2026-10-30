/** Emit the browser module loader's lazy-CJS registration artifact. */
import { build } from 'esbuild'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const { name } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const result = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  loader: { '.css': 'text' },
  write: false,
  legalComments: 'inline',
})
// The script only registers a factory. Imports, styles and apply execute when
// the module loader materializes the package with its shared require table.
const code = `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory(require){\nconst module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;\n}});\n`
await mkdir(new URL('lib/', root), { recursive: true })
await writeFile(new URL('lib/client.js', root), code)
