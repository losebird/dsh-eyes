/**
 * Bind vision onto official DeepSeek-V4-Flash / Pro.
 * Advertise image on resolveModelInfo (composer admission) and rewrite
 * ImageBlocks to text via the llm/stream waterfall before deepseek-official.
 * @module dsh-eyes/adapter
 */

import {
  askVision,
  contentHasImage,
  DEFAULT_MAX_IMAGE_BYTES,
  isImageRef,
  messagesHaveImage,
  positiveInt,
  readAttachment,
} from './vision.js'

export const UPSTREAM_PROVIDER = 'deepseek-official'
export const BOUND_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro'])

const CAPTION_PROMPT = [
  'Describe this image for a text-only language model that cannot see pixels.',
  'Include all visible text verbatim, objects, people, UI, layout, colors, and any detail needed to answer questions about the picture.',
  'Plain text only. Do not mention that you are a vision model.',
].join(' ')

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {() => import('./vision.js').EyesConfig} getConfig
 */
export function registerEyesRoute(ctx, getConfig) {
  wrapOfficialCatalog(ctx)
  ctx.on('llm/stream', (options, next) => interceptOfficialStream(ctx, getConfig, options, next))
}

function wrapOfficialCatalog(ctx) {
  const llm = ctx.llm
  const origList = llm.listModels
  const origResolve = llm.resolveModelInfo

  async function listModels(provider) {
    const models = await origList.call(this, provider)
    if (provider !== UPSTREAM_PROVIDER) return models
    return models.map(model => (
      BOUND_MODELS.has(model.id) ? { ...model, inputModalities: ['text', 'image'] } : model
    ))
  }

  async function resolveModelInfo(provider, model, signal) {
    const info = await origResolve.call(this, provider, model, signal)
    if (provider !== UPSTREAM_PROVIDER || !BOUND_MODELS.has(model)) return info
    return { ...info, inputModalities: ['text', 'image'] }
  }

  llm.listModels = listModels
  llm.resolveModelInfo = resolveModelInfo

  ctx.effect(() => () => {
    if (llm.listModels === listModels) llm.listModels = origList
    if (llm.resolveModelInfo === resolveModelInfo) llm.resolveModelInfo = origResolve
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {() => import('./vision.js').EyesConfig} getConfig
 * @param {any} options
 * @param {() => AsyncIterable<any>} next
 */
const rewrittenCalls = new WeakSet()

function interceptOfficialStream(ctx, getConfig, options, next) {
  if (rewrittenCalls.has(options)) return next()
  if (options?.provider !== UPSTREAM_PROVIDER) return next()
  if (!BOUND_MODELS.has(String(options?.model ?? ''))) return next()
  if (!messagesHaveImage(options?.messages)) return next()

  return (async function* () {
    const rewritten = await replaceImagesWithText(ctx, getConfig(), options.messages, options.signal)
    assertTextOnlyMessages(rewritten)
    const forwarded = { ...options, messages: rewritten }
    rewrittenCalls.add(forwarded)
    const llm = ctx.llm
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('dsh-eyes: ctx.llm.stream is unavailable')
    }
    yield* llm.stream(forwarded)
  })()
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./vision.js').EyesConfig} config
 * @param {readonly unknown[]} messages
 * @param {AbortSignal | undefined} signal
 */
export async function replaceImagesWithText(ctx, config, messages, signal) {
  if (!Array.isArray(messages)) return []
  const cache = new Map()
  const out = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      out.push(message)
      continue
    }
    if (!contentHasImage(message.content)) {
      out.push(message)
      continue
    }
    out.push({
      ...message,
      content: await rewriteBlocks(ctx, config, message.content, cache, signal),
    })
  }
  return out
}

async function rewriteBlocks(ctx, config, blocks, cache, signal) {
  if (!Array.isArray(blocks)) return []
  const out = []
  for (const block of blocks) {
    if (block?.type === 'image') {
      out.push({ type: 'text', text: await captionImage(ctx, config, block.attachment, cache, signal) })
      continue
    }
    if (block?.type === 'tool-result') {
      out.push({
        ...block,
        content: await rewriteBlocks(ctx, config, block.content, cache, signal),
      })
      continue
    }
    out.push(block)
  }
  return out
}

async function captionImage(ctx, config, attachment, cache, signal) {
  if (!isImageRef(attachment)) {
    throw new Error('dsh-eyes: image block is missing a durable attachment reference')
  }
  const ref = attachment
  const hit = cache.get(ref.attachmentId)
  if (hit !== undefined) return hit
  const maxBytes = positiveInt(config.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES)
  const loaded = await readAttachment(ctx, ref, signal, maxBytes)
  const description = await askVision(ctx, config, CAPTION_PROMPT, loaded, signal)
  const label = ref.name ? ` (${ref.name})` : ''
  const text = [`[Image${label} ${ref.width}x${ref.height} ${ref.mediaType}]`, description.trim()].join('\n')
  cache.set(ref.attachmentId, text)
  return text
}

function assertTextOnlyMessages(messages) {
  for (const message of messages) {
    if (message && typeof message === 'object' && contentHasImage(message.content)) {
      throw new Error('dsh-eyes: refused to forward ImageBlocks to deepseek-official')
    }
  }
}
