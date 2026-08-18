/**
 * Local agent-CLI vision backends. Spawn grok / claude / codex already
 * logged in on the machine. Never read or copy auth files.
 * @module dsh-eyes/cli-vision
 */

import { spawn } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

export const CLI_BACKENDS = {
  'grok-cli': {
    bin: 'grok',
    missing: '本机没找到 grok 命令。先安装并登录 Grok Build（grok login），或把 cliPath 指到 grok 可执行文件。',
  },
  'claude-cli': {
    bin: 'claude',
    missing: '本机没找到 claude 命令。先安装并登录 Claude Code，或把 cliPath 指到 claude 可执行文件。',
  },
  'codex-cli': {
    bin: 'codex',
    missing: '本机没找到 codex 命令。先安装并登录 Codex CLI，或把 cliPath 指到 codex 可执行文件。',
  },
}

const ALLOWED_BINS = new Set(['grok', 'claude', 'codex', 'grok.exe', 'claude.exe', 'codex.exe'])

const EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/**
 * @param {import('./vision.js').EyesConfig} config
 * @param {string} prompt
 * @param {{ data: Uint8Array, mediaType: string, source: string }} image
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 */
export async function askVisionCli(config, prompt, image, signal, timeoutMs) {
  const backend = CLI_BACKENDS[config.backend] ? config.backend : 'grok-cli'
  const spec = CLI_BACKENDS[backend]
  const requested = typeof config.cliPath === 'string' && config.cliPath.trim()
    ? config.cliPath.trim()
    : spec.bin
  const bin = await resolveExecutable(requested)
  if (!bin) throw new Error(spec.missing)
  const base = bin.split(/[/\\]/).pop() || ''
  if (!ALLOWED_BINS.has(base.toLowerCase())) {
    throw new Error('cliPath 只能指向 grok / claude / codex，不能用别的程序看图。')
  }

  const dir = await mkdtemp(join(tmpdir(), 'dsh-eyes-'))
  const ext = EXT[image.mediaType] || 'png'
  const imagePath = join(dir, `image.${ext}`)
  await writeFile(imagePath, image.data)
  const question = [
    prompt.trim(),
    '',
    `The image file is at: ${imagePath}`,
    'Open that file and ground your answer only in what is visible.',
    'Reply in plain text only.',
  ].join('\n')

  try {
    const args = buildArgs(backend, question, config.cliModel || config.model)
    const { stdout, stderr, code } = await run(bin, args, { cwd: dir, signal, timeoutMs })
    const text = stdout.trim()
    if (code !== 0 && !text) {
      throw new Error(`${backend} 退出码 ${code}。${redact((stderr || '').trim()) || '没有输出'}`)
    }
    if (!text) throw new Error(`${backend} 没有返回文字。`)
    return text
  } catch (error) {
    if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
      throw new Error(spec.missing)
    }
    throw error
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * @param {string} backend
 * @param {string} question
 * @param {string | undefined} model
 */
function buildArgs(backend, question, model) {
  const modelFlag = typeof model === 'string' && model.trim() ? model.trim() : ''
  if (backend === 'claude-cli') {
    const args = ['-p', '--output-format', 'text']
    if (modelFlag) args.push('--model', modelFlag)
    args.push(question)
    return args
  }
  if (backend === 'codex-cli') {
    const args = ['exec']
    if (modelFlag) args.push('-m', modelFlag)
    args.push(question)
    return args
  }
  // grok: -p requires the prompt value (not a boolean).
  const args = ['-p', question, '--output-format', 'plain']
  if (modelFlag) args.push('-m', modelFlag)
  return args
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{ cwd: string, signal?: AbortSignal, timeoutMs: number }} opts
 */
function run(bin, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })

    const onAbort = () => {
      child.kill('SIGTERM')
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`本机 CLI 看图超时（${opts.timeoutMs}ms）`))
    }, opts.timeoutMs)
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', error => {
      cleanup()
      reject(error)
    })
    child.on('close', code => {
      cleanup()
      resolve({ stdout, stderr, code: code ?? 1 })
    })

    function cleanup() {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  })
}

/** @param {string} nameOrPath */
export async function resolveExecutable(nameOrPath) {
  if (nameOrPath.includes('/') || nameOrPath.includes('\\') || isAbsolute(nameOrPath)) {
    return await isExecutable(nameOrPath) ? nameOrPath : undefined
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, nameOrPath)
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

/** @param {string} path */
async function isExecutable(path) {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** @param {string} text */
function redact(text) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-+=/]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(/xai-[A-Za-z0-9]{8,}/g, '[redacted]')
}
