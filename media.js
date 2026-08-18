/**
 * Turn PDF / video / Office files into text + page/frame images for askVision.
 * Uses already-installed pdftoppm, ffmpeg, unzip. Never a shell string.
 * @module dsh-eyes/media
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { promisify } from 'node:util'
import { loadImage } from './vision.js'

const execFileAsync = promisify(execFile)

export const DEFAULT_MAX_PAGES = 8
export const DEFAULT_MAX_FRAMES = 8

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v'])
const PDF_EXT = new Set(['.pdf'])
const OFFICE_EXT = new Set(['.docx', '.xlsx', '.pptx'])

const CONV_BINS = new Set(['pdftoppm', 'pdftotext', 'ffmpeg', 'ffprobe', 'unzip'])

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ signal?: AbortSignal, agent?: unknown }} exec
 * @param {string | undefined} ref
 * @param {import('./vision.js').EyesConfig} config
 */
export async function loadVisual(ctx, exec, ref, config) {
  const raw = typeof ref === 'string' ? ref.trim() : ''
  if (!raw || raw.startsWith('data:image/') || /^https?:\/\//i.test(raw) || looksLikeAttachmentId(raw)) {
    const image = await loadImage(ctx, exec, raw || undefined, config)
    return { kind: 'image', title: image.source, text: '', images: [image] }
  }

  const filePath = stripFileUrl(raw)
  const abs = await resolveLocal(ctx, exec, filePath)
  const bytes = await readFile(abs)
  const head = bytes.subarray(0, 16)
  const ext = extname(abs).toLowerCase()

  if (isPng(head) || isJpeg(head) || isGif(head) || isWebp(bytes) || IMAGE_EXT.has(ext)) {
    const image = await loadImage(ctx, exec, abs, config)
    return { kind: 'image', title: abs, text: '', images: [image] }
  }

  const maxPages = clampInt(config.maxPages, DEFAULT_MAX_PAGES, 1, 30)
  const maxFrames = clampInt(config.maxFrames, DEFAULT_MAX_FRAMES, 1, 16)

  if (isPdf(head) || PDF_EXT.has(ext)) {
    return loadPdf(abs, maxPages, exec.signal)
  }
  if (VIDEO_EXT.has(ext) || (await looksLikeVideo(abs, exec.signal))) {
    return loadVideo(abs, maxFrames, exec.signal)
  }
  if (isZip(head) && OFFICE_EXT.has(ext)) {
    return loadOffice(abs, ext, exec.signal)
  }
  if (isZip(head)) {
    throw new Error(`不认识的压缩包，眼睛现在只拆 docx / xlsx / pptx：${abs}`)
  }
  throw new Error(`眼睛还不认识这个文件：${abs}。现在能看图、PDF、常见视频、Word/Excel/PPT。`)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./vision.js').EyesConfig} config
 * @param {string} question
 * @param {{ kind: string, title: string, text: string, images: Array<{ data: Uint8Array, mediaType: string, source: string }> }} visual
 * @param {AbortSignal | undefined} signal
 * @param {'see' | 'ocr'} mode
 * @param {(ctx: import('@deepseek-ai/cordis').Context, config: import('./vision.js').EyesConfig, prompt: string, image: { data: Uint8Array, mediaType: string, source: string }, signal?: AbortSignal) => Promise<string>} askVision
 */
export async function askAboutVisual(ctx, config, question, visual, signal, mode, askVision) {
  const parts = []
  if (visual.text && visual.text.trim()) {
    parts.push(`【从文件抽出的文字 · ${visual.kind}】\n${visual.text.trim()}`)
  }
  if (!visual.images.length) {
    if (!parts.length) return '这个文件里没有可读的文字，也没有能看的图。'
    return parts.join('\n\n')
  }
  const limit = visual.images.length
  for (let i = 0; i < limit; i++) {
    const image = visual.images[i]
    const label = `${visual.kind} ${i + 1}/${limit} · ${image.source}`
    const prompt = mode === 'ocr'
      ? [
          'Extract all visible text from this image.',
          'Preserve reading order and line breaks. Do not translate.',
          `This is ${label}.`,
          'Return plain text only.',
        ].join('\n')
      : [
          'You are a careful vision assistant. Answer the user question about this page/frame.',
          'Reply in plain text only. Be specific and grounded in what is visible.',
          `This is ${label}.`,
          `Question: ${question}`,
        ].join('\n')
    const seen = await askVision(ctx, config, prompt, image, signal)
    parts.push(`【画面 ${i + 1}/${limit}】\n${seen}`)
  }
  return parts.join('\n\n')
}

async function loadPdf(abs, maxPages, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-eyes-pdf-'))
  try {
    await runAllowed('pdftoppm', ['-png', '-r', '120', '-f', '1', '-l', String(maxPages), abs, join(dir, 'page')], { signal })
    let text = ''
    try {
      const out = await runAllowed('pdftotext', ['-layout', '-f', '1', '-l', String(maxPages), abs, '-'], { signal })
      text = (out.stdout || '').trim()
    } catch {
      text = ''
    }
    const images = await readDirImages(dir, abs)
    if (!images.length && !text) throw new Error(`PDF 没有转出页面：${abs}`)
    return { kind: 'pdf', title: abs, text, images }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function loadVideo(abs, maxFrames, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-eyes-vid-'))
  try {
    let meta = ''
    try {
      const out = await runAllowed('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type',
        '-of', 'default=nw=1', abs,
      ], { signal })
      meta = (out.stdout || '').trim()
    } catch {
      meta = ''
    }
    await runAllowed('ffmpeg', [
      '-y', '-i', abs, '-vf', `fps=1,scale='min(1280,iw)':-2`,
      '-frames:v', String(maxFrames), join(dir, 'frame-%03d.png'),
    ], { signal, timeoutMs: 60_000 })
    const images = await readDirImages(dir, abs)
    const text = meta ? `视频信息：\n${meta}` : ''
    if (!images.length) throw new Error(`视频没有抽出帧：${abs}`)
    return { kind: 'video', title: abs, text, images }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function loadOffice(abs, ext, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-eyes-off-'))
  try {
    await runAllowed('unzip', ['-qq', '-o', abs, '-d', dir], { signal })
    const text = await readOfficeText(dir, ext)
    const images = await readOfficeMedia(dir, abs)
    if (!text.trim() && !images.length) {
      throw new Error(`这个 Office 文件是空的，或坏了：${abs}`)
    }
    const note = images.length
      ? ''
      : '\n（本机没有把幻灯片/页面画成图的程序，所以只抽出了文字。版式要看的话，先另存 PDF 或截图。）'
    return { kind: officeKind(ext), title: abs, text: text + note, images }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function readOfficeText(dir, ext) {
  if (ext === '.docx') {
    return xmlToText(await readMaybe(join(dir, 'word', 'document.xml')))
  }
  if (ext === '.pptx') {
    const slidesDir = join(dir, 'ppt', 'slides')
    let names = []
    try { names = (await readdir(slidesDir)).filter((n) => /^slide\d+\.xml$/i.test(n)).sort(slideSort) } catch { names = [] }
    const chunks = []
    for (const name of names) {
      const body = xmlToText(await readMaybe(join(slidesDir, name)))
      if (body) chunks.push(`幻灯片 ${name}：\n${body}`)
    }
    return chunks.join('\n\n')
  }
  if (ext === '.xlsx') {
    const shared = parseSharedStrings(await readMaybe(join(dir, 'xl', 'sharedStrings.xml')))
    const sheetsDir = join(dir, 'xl', 'worksheets')
    let names = []
    try { names = (await readdir(sheetsDir)).filter((n) => n.endsWith('.xml')).sort() } catch { names = [] }
    const chunks = []
    for (const name of names) {
      const rows = sheetToRows(await readMaybe(join(sheetsDir, name)), shared)
      if (rows) chunks.push(`表 ${name}：\n${rows}`)
    }
    return chunks.join('\n\n')
  }
  return ''
}

async function readOfficeMedia(dir, abs) {
  const roots = [join(dir, 'word', 'media'), join(dir, 'ppt', 'media'), join(dir, 'xl', 'media')]
  const images = []
  for (const root of roots) {
    let names = []
    try { names = await readdir(root) } catch { continue }
    for (const name of names) {
      const full = join(root, name)
      try {
        const data = new Uint8Array(await readFile(full))
        const mediaType = sniffImage(data)
        if (!mediaType) continue
        images.push({ data, mediaType, source: `${abs}#${name}` })
      } catch { /* skip */ }
    }
  }
  return images
}

async function readDirImages(dir, abs) {
  const names = (await readdir(dir)).filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).sort()
  const images = []
  for (const name of names) {
    const data = new Uint8Array(await readFile(join(dir, name)))
    const mediaType = sniffImage(data) || 'image/png'
    images.push({ data, mediaType, source: `${abs}#${name}` })
  }
  return images
}

async function resolveLocal(ctx, exec, filePath) {
  const fs = ctx.get('fs')
  if (fs && typeof fs.resolve === 'function') {
    const cwd = exec.agent?.session?.header?.cwd
    const target = await fs.resolve(filePath, {
      ...typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {},
      signal: exec.signal,
    })
    return target.realPath || target.displayPath || String(target)
  }
  const cwd = exec.agent?.session?.header?.cwd
  return isAbsolute(filePath)
    ? filePath
    : resolvePath(typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(), filePath)
}

async function looksLikeVideo(abs, signal) {
  try {
    const out = await runAllowed('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', abs], { signal, timeoutMs: 8_000 })
    return /video/i.test(out.stdout || '')
  } catch {
    return false
  }
}

async function runAllowed(bin, args, opts = {}) {
  const base = bin.split(/[/\\]/).pop() || ''
  if (!CONV_BINS.has(base)) throw new Error(`不允许运行 ${bin}`)
  const timeoutMs = opts.timeoutMs || 45_000
  try {
    return await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      signal: opts.signal,
    })
  } catch (error) {
    const err = /** @type {Error & { stderr?: string, code?: string }} */ (error)
    if (err.code === 'ENOENT') {
      throw new Error(`本机没有 ${base}，没法处理这类文件。`)
    }
    throw new Error(`${base} 失败：${(err.stderr || err.message || '').toString().slice(0, 240)}`)
  }
}

function xmlToText(xml) {
  if (!xml) return ''
  return xml
    .replace(/<w:tab\b[^/]*\/>/g, '\t')
    .replace(/<w:br\b[^/]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseSharedStrings(xml) {
  if (!xml) return []
  const out = []
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let match
  while ((match = re.exec(xml))) {
    out.push(xmlToText(match[1]))
  }
  return out
}

function sheetToRows(xml, shared) {
  if (!xml) return ''
  const rows = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let row
  while ((row = rowRe.exec(xml))) {
    const cells = []
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g
    let cell
    while ((cell = cellRe.exec(row[1]))) {
      const attrs = cell[1]
      const inner = cell[2]
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || ''
      if (/\bt="s"/.test(attrs)) cells.push(shared[Number(v)] || '')
      else cells.push(v)
    }
    if (cells.some((c) => String(c).trim())) rows.push(cells.join('\t'))
  }
  return rows.join('\n')
}

function slideSort(a, b) {
  return (Number((a.match(/\d+/) || ['0'])[0]) - Number((b.match(/\d+/) || ['0'])[0]))
}

function officeKind(ext) {
  if (ext === '.docx') return 'docx'
  if (ext === '.xlsx') return 'xlsx'
  return 'pptx'
}

async function readMaybe(path) {
  try { return await readFile(path, 'utf8') } catch { return '' }
}

function sniffImage(bytes) {
  if (isPng(bytes)) return 'image/png'
  if (isJpeg(bytes)) return 'image/jpeg'
  if (isGif(bytes)) return 'image/gif'
  if (isWebp(bytes)) return 'image/webp'
  return undefined
}

function isPng(b) { return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 }
function isJpeg(b) { return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }
function isGif(b) { return b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 }
function isWebp(b) {
  return b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
}
function isPdf(b) { return b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 }
function isZip(b) { return b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b }

function looksLikeAttachmentId(value) {
  return value.startsWith('sha256:') || /^[a-f0-9]{64}$/i.test(value)
}

function stripFileUrl(value) {
  return value.startsWith('file://') ? value.slice('file://'.length) : value
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
