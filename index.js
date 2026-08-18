/**
 * Host-only dsh plugin: bind vision onto official DeepSeek-V4-Flash / Pro.
 * Tools return text. Paste is admitted on those two official models.
 * @module dsh-eyes
 */

import { registerEyesRoute } from './adapter.js'
import { importPeer } from './peers.js'
import { loadOverlaySync, mergeConfig } from './persist.js'
import { registerSettingsApi } from './settings-api.js'
import { askVision, DEFAULT_MAX_IMAGE_BYTES, DEFAULT_TIMEOUT_MS } from './vision.js'
import { askAboutVisual, DEFAULT_MAX_FRAMES, DEFAULT_MAX_PAGES, loadVisual } from './media.js'

// Sequential: schemastery is CJS and shares cosmokit with dsh-tools.
// Parallel dynamic import races Node's CJS/ESM interop.
const schemaMod = await importPeer('@deepseek-ai/schemastery')
const { defineTool } = await importPeer('@deepseek-ai/dsh-tools')
const Schema = schemaMod.default

export const name = 'dsh-eyes'
export const inject = ['tools', 'llm']

export { BOUND_MODELS, UPSTREAM_PROVIDER } from './adapter.js'

/** @typedef {import('./vision.js').EyesConfig} Config */

export const Config = Schema.object({
  backend: Schema.union([
    'grok-cli', 'claude-cli', 'codex-cli',
    'xai', 'openai', 'qwen', 'custom',
  ]).default('grok-cli'),
  baseURL: Schema.string(),
  model: Schema.string(),
  apiKeyEnv: Schema.string(),
  cliPath: Schema.string(),
  cliModel: Schema.string(),
  timeoutMs: Schema.number().default(DEFAULT_TIMEOUT_MS),
  maxImageBytes: Schema.number().default(DEFAULT_MAX_IMAGE_BYTES),
  maxPages: Schema.number().default(DEFAULT_MAX_PAGES),
  maxFrames: Schema.number().default(DEFAULT_MAX_FRAMES),
})

const PROMPT_SECTION = [
  'Official DeepSeek-V4-Flash and DeepSeek-V4-Pro can accept pasted images: dsh-eyes turns each image into text via grok/claude/codex CLI or an HTTP vision API, then DeepSeek continues in text only.',
  'When the user pastes or attaches an image, or asks about a picture, call see_image.',
  'When they want printed or on-screen text read out, call ocr_image.',
  'When they ask where something is in a picture ("where is X"), call locate_in_image.',
  'The composer has a file button (and drop/paste) for PDF, video, Word, Excel, and PowerPoint. dsh-eyes saves the original and puts the filesystem path in the draft.',
  'When the user uploaded or named such a file, call see_file with that path. Do not use read on those binaries.',
  'These tools return TEXT only — do not use read_image for a text-only main model.',
  'If the user just attached or pasted an image, omit the image/file argument and the tool will use the latest attachment.',
].join(' ')

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Config} config
 */
export function apply(ctx, config) {
  /** @type {() => Config} */
  let current = () => config

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register('dsh-eyes', Config, {
      base: config,
      applies: 'live',
    })
    current = () => scope.get()
    sctx.effect(() => () => {
      current = () => config
    })
  })

  const getConfig = () => mergeConfig(current())
  loadOverlaySync()
  registerSettingsApi(ctx, current)
  registerEyesRoute(ctx, getConfig)

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    systemPrompt.section({
      name: 'tool:dsh-eyes',
      order: 118,
      text: PROMPT_SECTION,
    })
  }

  ctx.tools.register(defineTool({
    name: 'see_image',
    description: 'Look at an image with a vision model and return a text description or answer. Use when the user pastes/attaches a picture or asks what is in it. Omit image to use the latest session attachment.',
    parameters: {
      question: {
        type: 'string',
        required: true,
        description: 'What to look for or ask about the image.',
      },
      image: {
        type: 'string',
        description: 'Filesystem path, http(s) URL, or attachment id. Omit to use the latest attached image.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const question = String(args.question ?? '').trim() || 'Describe this image.'
      const visual = await loadVisual(ctx, exec, args.image, getConfig())
      if (visual.kind === 'image' && visual.images.length === 1 && !visual.text) {
        const prompt = [
          'You are a careful vision assistant. Answer the user question about this image.',
          'Reply in plain text only. Be specific and grounded in what is visible.',
          `Question: ${question}`,
        ].join('\n')
        return askVision(ctx, getConfig(), prompt, visual.images[0], exec.signal)
      }
      return askAboutVisual(ctx, getConfig(), question, visual, exec.signal, 'see', askVision)
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: args.image ? `See image ${args.image}` : 'See latest image',
        kind: 'read',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ocr_image',
    description: 'Extract visible text from an image (OCR). Use when the user wants printed, handwritten, or on-screen text read. Omit image to use the latest session attachment.',
    parameters: {
      image: {
        type: 'string',
        description: 'Filesystem path, http(s) URL, or attachment id. Omit to use the latest attached image.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const visual = await loadVisual(ctx, exec, args.image, getConfig())
      if (visual.kind === 'image' && visual.images.length === 1 && !visual.text) {
        const prompt = [
          'Extract all visible text from this image.',
          'Preserve reading order and line breaks. Do not translate.',
          'If a region is unreadable, write [unreadable] there.',
          'If there is no text, say so in one sentence.',
          'Return plain text only — no commentary unless there is no text.',
        ].join('\n')
        return askVision(ctx, getConfig(), prompt, visual.images[0], exec.signal)
      }
      return askAboutVisual(ctx, getConfig(), 'Extract all visible text.', visual, exec.signal, 'ocr', askVision)
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: args.image ? `OCR ${args.image}` : 'OCR latest image',
        kind: 'read',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'locate_in_image',
    description: 'Find a target in an image and return bounding boxes as text (percent or pixels) plus labels. Use for "where is X". Omit image to use the latest session attachment.',
    parameters: {
      target: {
        type: 'string',
        required: true,
        description: 'What to find in the image.',
      },
      image: {
        type: 'string',
        description: 'Filesystem path, http(s) URL, or attachment id. Omit to use the latest attached image.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const loaded = await loadImage(ctx, exec, args.image, getConfig())
      const target = String(args.target ?? '').trim()
      if (!target) throw new Error('target must be a non-empty string')
      const prompt = [
        `Locate every instance of: ${target}`,
        'For each match, give a label and a box.',
        'Prefer percent of image width/height: x, y, w, h in 0-100, origin top-left.',
        'If you can see exact pixel size, you may also give px boxes.',
        'If nothing matches, say so clearly.',
        'Plain text only. Example:',
        '1. red mug — 12%, 40%, 18%, 22% (percent x,y,w,h)',
      ].join('\n')
      return askVision(ctx, getConfig(), prompt, loaded, exec.signal)
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: args.target ? `Locate ${args.target}` : 'Locate in image',
        kind: 'read',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'see_file',
    description: 'Look at a workspace file that is not a pasted image: PDF, video, Word, Excel, or PowerPoint. Pass a filesystem path. Returns text only. Use this instead of read for those binaries.',
    parameters: {
      file: {
        type: 'string',
        required: true,
        description: 'Filesystem path to a PDF, video, docx, xlsx, pptx, or image.',
      },
      question: {
        type: 'string',
        description: 'What to look for. Default: describe the file.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const file = String(args.file ?? '').trim()
      if (!file) throw new Error('file must be a non-empty path')
      const question = String(args.question ?? '').trim() || 'Describe this file. Read visible text and say what is on each page or frame.'
      const visual = await loadVisual(ctx, exec, file, getConfig())
      return askAboutVisual(ctx, getConfig(), question, visual, exec.signal, 'see', askVision)
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: args.file ? `See file ${args.file}` : 'See file',
        kind: 'read',
      }
    },
  }))
}
