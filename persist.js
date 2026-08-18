/**
 * User overlay for dsh-eyes. Written by the Settings page, read on every
 * vision call. Never stores API keys — only the env var name.
 * @module dsh-eyes/persist
 */

import { chmodSync, readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const BACKENDS = [
  'grok-cli', 'claude-cli', 'codex-cli',
  'xai', 'openai', 'qwen', 'custom',
]

const STRING_KEYS = ['backend', 'baseURL', 'model', 'apiKeyEnv', 'cliPath', 'cliModel']
const NUMBER_KEYS = ['timeoutMs', 'maxImageBytes', 'maxPages', 'maxFrames']

export function overlayPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-eyes.json')
}

/** @type {Record<string, unknown> | null} */
let cache = null

export function loadOverlaySync() {
  if (cache) return cache
  try {
    cache = sanitize(JSON.parse(readFileSync(overlayPath(), 'utf8')), { partial: true })
  } catch {
    cache = {}
  }
  return cache
}

export async function loadOverlay() {
  if (cache) return cache
  try {
    const raw = await readFile(overlayPath(), 'utf8')
    cache = sanitize(JSON.parse(raw), { partial: true })
  } catch {
    cache = {}
  }
  return cache
}

export function peekOverlay() {
  return cache || {}
}

/**
 * @param {unknown} input
 * @param {{ partial?: boolean }} [opts]
 */
export function sanitize(input, opts = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('配置必须是一个对象')
  }
  const src = /** @type {Record<string, unknown>} */ (input)
  if ('apiKey' in src || 'token' in src || 'secret' in src || 'password' in src) {
    throw new Error('不要把钥匙写进配置。只填环境变量名 apiKeyEnv。')
  }
  /** @type {Record<string, unknown>} */
  const out = {}
  if (src.backend !== undefined) {
    const backend = String(src.backend)
    if (!BACKENDS.includes(backend)) throw new Error(`不认识的后端：${backend}`)
    out.backend = backend
  } else if (!opts.partial) {
    throw new Error('缺少 backend')
  }
  for (const key of STRING_KEYS) {
    if (key === 'backend') continue
    if (src[key] === undefined) continue
    if (typeof src[key] !== 'string') throw new Error(`${key} 必须是文字`)
    const value = src[key].trim()
    if (key === 'apiKeyEnv' && value && !/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) {
      throw new Error('apiKeyEnv 只能是环境变量名，比如 XAI_API_KEY')
    }
    if (key === 'baseURL' && value && !/^https?:\/\//i.test(value) && value !== '') {
      throw new Error('baseURL 要以 http:// 或 https:// 开头')
    }
    if (key === 'cliPath' && value) {
      const base = value.split(/[/\\]/).pop() || ''
      if (!/^(grok|claude|codex)(\.exe)?$/i.test(base)) {
        throw new Error('cliPath 只能指向 grok / claude / codex')
      }
    }
    out[key] = value.slice(0, 500)
  }
  if (src.timeoutMs !== undefined) {
    const n = Number(src.timeoutMs)
    if (!Number.isFinite(n) || n < 1_000 || n > 600_000) {
      throw new Error('timeoutMs 要在 1000 到 600000 之间')
    }
    out.timeoutMs = Math.round(n)
  }
  if (src.maxImageBytes !== undefined) {
    const n = Number(src.maxImageBytes)
    if (!Number.isFinite(n) || n < 1024 || n > 30 * 1024 * 1024) {
      throw new Error('maxImageBytes 要在 1KB 到 30MB 之间')
    }
    out.maxImageBytes = Math.round(n)
  }
  if (src.maxPages !== undefined) {
    const n = Number(src.maxPages)
    if (!Number.isFinite(n) || n < 1 || n > 30) {
      throw new Error('maxPages 要在 1 到 30 之间')
    }
    out.maxPages = Math.round(n)
  }
  if (src.maxFrames !== undefined) {
    const n = Number(src.maxFrames)
    if (!Number.isFinite(n) || n < 1 || n > 16) {
      throw new Error('maxFrames 要在 1 到 16 之间')
    }
    out.maxFrames = Math.round(n)
  }
  return out
}

/**
 * @param {unknown} input
 */
export async function saveOverlay(input) {
  const next = { ...peekOverlay(), ...sanitize(input, { partial: true }) }
  const path = overlayPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  try { await chmod(path, 0o600) } catch { /* best-effort */ }
  cache = next
  return next
}

/**
 * @template {Record<string, unknown>} T
 * @param {T} base
 */
export function mergeConfig(base) {
  return { ...base, ...peekOverlay() }
}
