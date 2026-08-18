/**
 * Resolve a dsh peer from the usual Node walk, then from $DSH_HOME.
 * Local `link:` installs realpath out of the profile, so peers are not
 * visible next to this file.
 * @module dsh-eyes/peers
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * @param {string} spec
 */
export async function importPeer(spec) {
  try {
    return await import(spec)
  } catch (error) {
    const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
    for (const home of homes) {
      for (const rel of ['profiles/node_modules', 'profiles/web/node_modules']) {
        const pkgJson = join(home, rel, spec, 'package.json')
        if (!existsSync(pkgJson)) continue
        try {
          const resolved = createRequire(pkgJson).resolve(spec)
          return await import(pathToFileURL(resolved).href)
        } catch {
          try {
            const resolved = createRequire(pkgJson).resolve('.')
            return await import(pathToFileURL(resolved).href)
          } catch {
            // try the next root
          }
        }
      }
    }
    throw error
  }
}
