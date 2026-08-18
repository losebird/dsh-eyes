/**
 * Save a file the user picked or dropped. Recognition is see_file later.
 * @module dsh-eyes/intake
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'

export const MAX_INTAKE_BYTES = 48 * 1024 * 1024

const ALLOWED_EXT = new Set([
  '.pdf', '.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v',
  '.docx', '.xlsx', '.pptx',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
])

export function inboxDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-eyes-inbox')
}

function safeName(name) {
  const base = basename(String(name || 'upload').replace(/\\/g, '/'))
  const cleaned = base.replace(/[^\w.\u4e00-\u9fff-]+/g, '_').replace(/^\.+/, '')
  return (cleaned || 'upload').slice(0, 120)
}

/**
 * @param {unknown} _ctx
 * @param {unknown} _config
 * @param {{ name?: string, dataBase64?: string }} body
 */
export async function intakeFile(_ctx, _config, body) {
  if (!body || typeof body !== 'object') throw new Error('intake 需要一个对象')
  const name = safeName(body.name)
  const ext = extname(name).toLowerCase()
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error('现在只收图片、PDF、常见视频、Word / Excel / PPT')
  }
  const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : ''
  if (!dataBase64) throw new Error('没有文件内容')
  let buf
  try {
    buf = Buffer.from(dataBase64, 'base64')
  } catch {
    throw new Error('文件内容不是 base64')
  }
  if (!buf.length) throw new Error('文件是空的')
  if (buf.length > MAX_INTAKE_BYTES) throw new Error('文件太大')

  const dir = inboxDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const stamp = Date.now().toString(36)
  const stem = name.slice(0, Math.max(0, name.length - ext.length)) || 'upload'
  const saved = join(dir, `${stem}-${stamp}${ext}`)
  await writeFile(saved, buf, { mode: 0o600 })
  return { ok: true, path: saved, name, ext: ext.slice(1) }
}
