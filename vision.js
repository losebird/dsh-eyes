/**
 * Shared vision backend: load bytes, call an OpenAI-compatible VL endpoint.
 * Keys come from apiKeyEnv only — never a literal secret.
 * @module dsh-eyes/vision
 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { askVisionCli } from './cli-vision.js'

/** @typedef {'xai' | 'openai' | 'qwen' | 'custom' | 'grok-cli' | 'claude-cli' | 'codex-cli'} EyesBackend */

/**
 * @typedef {object} EyesConfig
 * @property {EyesBackend} [backend]
 * @property {string} [baseURL]
 * @property {string} [model]
 * @property {string} [apiKeyEnv]
 * @property {string} [cliPath]
 * @property {string} [cliModel]
 * @property {number} [timeoutMs]
 * @property {number} [maxImageBytes]
 */

/** @type {Readonly<Record<EyesBackend, { baseURL: string, model: string, apiKeyEnv: string }>>} */
export const PRESETS = {
  xai: { kind: 'http', baseURL: 'https://api.x.ai/v1', model: 'grok-4.6', apiKeyEnv: 'XAI_API_KEY' },
  openai: { kind: 'http', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
  qwen: {
    kind: 'http',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
  },
  custom: { kind: 'http', baseURL: '', model: '', apiKeyEnv: '' },
  'grok-cli': { kind: 'cli', baseURL: '', model: '', apiKeyEnv: '' },
  'claude-cli': { kind: 'cli', baseURL: '', model: '', apiKeyEnv: '' },
  'codex-cli': { kind: 'cli', baseURL: '', model: '', apiKeyEnv: '' },
}

export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_IMAGE_BYTES = 10_485_760
const KNOWN_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-tools').ToolRunContext | { signal?: AbortSignal, agent?: unknown }} exec
 * @param {string | undefined} image
 * @param {EyesConfig} config
 */
export async function loadImage(ctx, exec, image, config) {
  const maxBytes = positiveInt(config.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES)
  const raw = typeof image === 'string' ? image.trim() : ''

  if (!raw) {
    const ref = findLatestAttachmentRef(exec)
    if (!ref) {
      throw new Error(
        'no image given and no recent session attachment found. Pass a filesystem path, an http(s) URL, or an attachment id.',
      )
    }
    return readAttachment(ctx, ref, exec.signal, maxBytes)
  }

  if (raw.startsWith('data:image/')) return decodeDataUrl(raw, maxBytes)
  if (/^https?:\/\//i.test(raw)) return fetchRemoteImage(raw, exec.signal, maxBytes)

  if (looksLikeAttachmentId(raw)) {
    const ref = findAttachmentRefById(exec, raw)
    if (!ref) {
      throw new Error(
        `attachment id "${raw}" was not found in this session. Pass a filesystem path or http(s) URL, or attach the image first.`,
      )
    }
    return readAttachment(ctx, ref, exec.signal, maxBytes)
  }

  return readLocalImage(ctx, exec, stripFileUrl(raw), maxBytes)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ attachmentId: string, mediaType: string, bytes: number, width: number, height: number, name?: string }} ref
 * @param {AbortSignal | undefined} signal
 * @param {number} maxBytes
 */
export async function readAttachment(ctx, ref, signal, maxBytes) {
  const attachments = ctx.get('attachments')
  if (!attachments || typeof attachments.readImage !== 'function') {
    throw new Error('attachments service is not mounted; cannot read a session image attachment.')
  }
  if (ref.bytes > maxBytes) {
    throw new Error(`image is ${ref.bytes} bytes, over maxImageBytes=${maxBytes}`)
  }
  const stored = await attachments.readImage(ref, signal)
  const data = stored?.data
  if (!(data instanceof Uint8Array) || data.byteLength === 0) {
    throw new Error('attachments.readImage returned no bytes')
  }
  if (data.byteLength > maxBytes) {
    throw new Error(`image is ${data.byteLength} bytes, over maxImageBytes=${maxBytes}`)
  }
  const mediaType = stored.ref?.mediaType || ref.mediaType || sniffMediaType(data)
  if (!mediaType || !KNOWN_MEDIA.has(mediaType)) {
    throw new Error('attachment is not a PNG/JPEG/WebP/GIF image')
  }
  return { data, mediaType, source: `attachment:${ref.attachmentId}` }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {EyesConfig} config
 * @param {string} prompt
 * @param {{ data: Uint8Array, mediaType: string, source: string }} image
 * @param {AbortSignal | undefined} callerSignal
 */
export async function askVision(ctx, config, prompt, image, callerSignal) {
  const resolved = resolveBackend(config)
  const timeoutMs = positiveInt(config.timeoutMs, DEFAULT_TIMEOUT_MS)
  if (resolved.kind === 'cli') {
    return askVisionCli(config, prompt, image, callerSignal, timeoutMs)
  }
  if (!resolved.baseURL) {
    throw new Error('dsh-eyes: set baseURL (required for backend=custom, or to override a preset).')
  }
  if (!resolved.model) {
    throw new Error('dsh-eyes: set model (required for backend=custom, or to override a preset).')
  }

  const apiKey = await resolveApiKey(ctx, resolved.apiKeyEnv)
  if (!apiKey && resolved.backend !== 'custom') {
    throw new Error(
      `dsh-eyes: no API key for ${resolved.backend}. Set env ${resolved.apiKeyEnv}`
      + ' or add it to ~/.dsh/.credentials.yaml, then retry.',
    )
  }

  const { signal, dispose } = fuseTimeout(callerSignal, timeoutMs)
  const url = `${resolved.baseURL}/chat/completions`
  const body = {
    model: resolved.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: { url: toDataUrl(image.mediaType, image.data) },
        },
      ],
    }],
  }

  /** @type {HeadersInit} */
  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
    const raw = await response.text()
    if (!response.ok) {
      throw new Error(
        `vision backend HTTP ${response.status} (${resolved.backend} ${resolved.model}): ${summarizeBody(raw)}`,
      )
    }
    const text = extractCompletionText(raw)
    if (!text) {
      throw new Error(`vision backend returned empty content (${resolved.backend} ${resolved.model})`)
    }
    return text
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`vision request timed out or was cancelled after ${timeoutMs}ms`)
    }
    throw error instanceof Error ? error : new Error(errorMessage(error))
  } finally {
    dispose()
  }
}

/** @param {EyesConfig} config */
export function resolveBackend(config) {
  const backend = PRESETS[config.backend] ? config.backend : 'grok-cli'
  const preset = PRESETS[backend]
  return {
    backend,
    kind: preset.kind || 'http',
    baseURL: trimSlash(typeof config.baseURL === 'string' && config.baseURL.trim() ? config.baseURL.trim() : preset.baseURL),
    model: typeof config.model === 'string' && config.model.trim() ? config.model.trim() : preset.model,
    apiKeyEnv: typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.trim()
      ? config.apiKeyEnv.trim()
      : preset.apiKeyEnv,
  }
}

/**
 * Env first, then ctx.credentials. Never log the value.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} apiKeyEnv
 */
export async function resolveApiKey(ctx, apiKeyEnv) {
  if (!apiKeyEnv) return ''
  const fromEnv = process.env[apiKeyEnv]
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  const credentials = ctx.get('credentials')
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(apiKeyEnv)
      const value = resolved?.value
      if (typeof value === 'string' && value.trim()) return value.trim()
    } catch {
      // Invalid credential refs stay empty; the caller decides whether that is fatal.
    }
  }
  return ''
}

/** @param {unknown} content */
export function contentHasImage(content) {
  if (!Array.isArray(content)) return false
  return content.some(block => block?.type === 'image'
    || (block?.type === 'tool-result' && contentHasImage(block.content)))
}

/** @param {unknown} messages */
export function messagesHaveImage(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some(message => message && typeof message === 'object' && contentHasImage(message.content))
}

export function findLatestAttachmentRef(exec) {
  const events = exec?.agent?.session?.events
  if (!events) return undefined
  let found
  for (const event of events) {
    for (const ref of collectAttachmentRefs(event)) found = ref
  }
  return found
}

/**
 * @param {unknown} exec
 * @param {string} id
 */
function findAttachmentRefById(exec, id) {
  const events = exec?.agent?.session?.events
  if (!events) return undefined
  const aliases = new Set([id])
  if (/^[a-f0-9]{64}$/i.test(id)) aliases.add(`sha256:${id}`)
  let found
  for (const event of events) {
    for (const ref of collectAttachmentRefs(event)) {
      if (aliases.has(ref.attachmentId)) found = ref
    }
  }
  return found
}

/** @param {unknown} root */
export function collectAttachmentRefs(root) {
  /** @type {Array<{ attachmentId: string, mediaType: string, bytes: number, width: number, height: number, name?: string }>} */
  const refs = []
  const seen = new Set()
  const walk = (value) => {
    if (value == null || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    if (value.type === 'image' && isImageRef(value.attachment)) refs.push(value.attachment)
    else if (isImageRef(value)) refs.push(value)
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    for (const item of Object.values(value)) walk(item)
  }
  walk(root)
  return refs
}

/** @param {unknown} value */
export function isImageRef(value) {
  if (value == null || typeof value !== 'object') return false
  const ref = /** @type {Record<string, unknown>} */ (value)
  return typeof ref.attachmentId === 'string'
    && ref.attachmentId.length > 0
    && typeof ref.mediaType === 'string'
    && typeof ref.bytes === 'number'
    && typeof ref.width === 'number'
    && typeof ref.height === 'number'
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} exec
 * @param {string} filePath
 * @param {number} maxBytes
 */
async function readLocalImage(ctx, exec, filePath, maxBytes) {
  const fs = ctx.get('fs')
  if (fs && typeof fs.resolve === 'function' && typeof fs.readBytes === 'function') {
    const cwd = exec.agent?.session?.header?.cwd
    const target = await fs.resolve(filePath, {
      ...typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {},
      signal: exec.signal,
    })
    const data = await fs.readBytes(target, exec.signal, maxBytes)
    const mediaType = sniffMediaType(data) || mediaTypeFromPath(filePath)
    if (!mediaType) {
      throw new Error(`cannot read "${displayPath(target, filePath)}": not a PNG/JPEG/WebP/GIF image`)
    }
    return { data, mediaType, source: displayPath(target, filePath) }
  }

  const cwd = exec.agent?.session?.header?.cwd
  const abs = isAbsolute(filePath)
    ? filePath
    : resolvePath(typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(), filePath)
  let info
  try {
    info = await stat(abs)
  } catch (error) {
    throw new Error(`cannot read "${filePath}": ${errorMessage(error)}`)
  }
  if (!info.isFile()) throw new Error(`cannot read "${filePath}": not a regular file`)
  if (info.size > maxBytes) {
    throw new Error(`image is ${info.size} bytes, over maxImageBytes=${maxBytes}`)
  }
  const data = new Uint8Array(await readFile(abs))
  const mediaType = sniffMediaType(data) || mediaTypeFromPath(filePath)
  if (!mediaType) throw new Error(`cannot read "${filePath}": not a PNG/JPEG/WebP/GIF image`)
  return { data, mediaType, source: abs }
}

/**
 * @param {string} url
 * @param {AbortSignal | undefined} signal
 * @param {number} maxBytes
 */
async function fetchRemoteImage(url, signal, maxBytes) {
  let response
  try {
    response = await fetch(url, { method: 'GET', redirect: 'follow', signal })
  } catch (error) {
    throw new Error(`failed to fetch image: ${errorMessage(error)}`)
  }
  if (!response.ok) {
    throw new Error(`failed to fetch image: HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`image is ${declared} bytes, over maxImageBytes=${maxBytes}`)
  }
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.byteLength > maxBytes) {
    throw new Error(`image is ${buffer.byteLength} bytes, over maxImageBytes=${maxBytes}`)
  }
  const hint = mediaTypeFromContentType(response.headers.get('content-type'))
  const mediaType = sniffMediaType(buffer) || hint
  if (!mediaType) throw new Error(`fetched URL is not a PNG/JPEG/WebP/GIF image: ${url}`)
  return { data: buffer, mediaType, source: url }
}

/**
 * @param {string} dataUrl
 * @param {number} maxBytes
 */
function decodeDataUrl(dataUrl, maxBytes) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl)
  if (!match) throw new Error('unsupported data URL (expected data:image/...;base64,...)')
  const declared = match[1].toLowerCase()
  const data = new Uint8Array(Buffer.from(match[2], 'base64'))
  if (data.byteLength > maxBytes) {
    throw new Error(`image is ${data.byteLength} bytes, over maxImageBytes=${maxBytes}`)
  }
  const mediaType = sniffMediaType(data) || (KNOWN_MEDIA.has(declared) ? declared : undefined)
  if (!mediaType) throw new Error('data URL is not a PNG/JPEG/WebP/GIF image')
  return { data, mediaType, source: 'data-url' }
}

/** @param {string} value */
function looksLikeAttachmentId(value) {
  return value.startsWith('sha256:') || /^[a-f0-9]{64}$/i.test(value)
}

/** @param {Uint8Array} bytes */
function sniffMediaType(bytes) {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif'
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return undefined
}

/** @param {string} filePath */
function mediaTypeFromPath(filePath) {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return undefined
}

/** @param {string | null} contentType */
function mediaTypeFromContentType(contentType) {
  if (!contentType) return undefined
  const type = contentType.split(';')[0].trim().toLowerCase()
  return KNOWN_MEDIA.has(type) ? type : undefined
}

/**
 * @param {string} mediaType
 * @param {Uint8Array} data
 */
function toDataUrl(mediaType, data) {
  return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
}

/** @param {string} raw */
function extractCompletionText(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    const trimmed = raw.trim()
    return trimmed || undefined
  }
  const content = parsed?.choices?.[0]?.message?.content
  if (typeof content === 'string') {
    const text = content.trim()
    return text || undefined
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text
        return ''
      })
      .join('')
      .trim()
    return text || undefined
  }
  if (typeof parsed?.error?.message === 'string') {
    throw new Error(`vision backend error: ${parsed.error.message}`)
  }
  return undefined
}

/** @param {string} raw */
function summarizeBody(raw) {
  const cleaned = redactSecrets(raw).replace(/\s+/g, ' ').trim()
  if (!cleaned) return '(empty body)'
  try {
    const parsed = JSON.parse(raw)
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error
    if (typeof message === 'string' && message.trim()) return redactSecrets(message.trim())
  } catch {
    // fall through to raw snippet
  }
  return cleaned.length > 400 ? `${cleaned.slice(0, 400)}…` : cleaned
}

/** @param {string} text */
function redactSecrets(text) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-+=/]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(/xai-[A-Za-z0-9]{8,}/g, '[redacted]')
}

/**
 * @param {AbortSignal | undefined} caller
 * @param {number} timeoutMs
 */
function fuseTimeout(caller, timeoutMs) {
  const ac = new AbortController()
  const abort = () => {
    if (!ac.signal.aborted) ac.abort(caller?.reason ?? new Error('aborted'))
  }
  if (caller) {
    if (caller.aborted) abort()
    else caller.addEventListener('abort', abort, { once: true })
  }
  const timer = setTimeout(() => {
    if (!ac.signal.aborted) ac.abort(new Error(`timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  return {
    signal: ac.signal,
    dispose() {
      clearTimeout(timer)
      caller?.removeEventListener('abort', abort)
    },
  }
}

/** @param {unknown} error */
function isAbortError(error) {
  return (error instanceof Error && error.name === 'AbortError')
    || (error instanceof DOMException && error.name === 'AbortError')
}

/** @param {unknown} error */
function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/**
 * @param {unknown} target
 * @param {string} fallback
 */
function displayPath(target, fallback) {
  if (target && typeof target === 'object' && typeof target.displayPath === 'string') {
    return target.displayPath
  }
  return fallback
}

/** @param {string} value */
function stripFileUrl(value) {
  if (!value.startsWith('file://')) return value
  try {
    return decodeURIComponent(new URL(value).pathname)
  } catch {
    return value.slice('file://'.length)
  }
}

/** @param {string} value */
function trimSlash(value) {
  return value.replace(/\/+$/, '')
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
export function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
