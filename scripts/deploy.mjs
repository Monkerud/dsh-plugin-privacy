/**
 * Deploy: copy the built artifacts to both flat locations that DSH scans:
 *   1. Workspace\.dsh\plugins\dsh-agent-privacy          (plugin-market UI)
 *   2. Workspace\.dsh\profiles\web\node_modules\dsh-agent-privacy  (Loader resolution)
 * Runs after every `pnpm run build` so neither copy goes stale.
 */
import { cpSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const destinations = [
  'D:\\AI\\Apps\\DSH\\Workspace\\.dsh\\plugins\\dsh-agent-privacy',
  'D:\\AI\\Apps\\DSH\\Workspace\\.dsh\\profiles\\web\\node_modules\\dsh-agent-privacy',
]

const files = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js',
]
const maps = ['lib/index.js.map', 'lib/client.js.map']

for (const dest of destinations) {
  mkdirSync(join(dest, 'lib'), { recursive: true })
  for (const f of [...files, ...maps]) {
    const src = join(root, f)
    if (!existsSync(src)) continue
    cpSync(src, join(dest, f), { force: true })
  }
  console.log(`[deploy] → ${dest}`)
}

console.log('[deploy] done')
