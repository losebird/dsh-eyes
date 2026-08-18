/**
 * Loopback HTTP for the Settings → 看图 page.
 * Same Host/Origin door as the official /api fence: other websites cannot
 * change the backend. This is not a login.
 * @module dsh-eyes/settings-api
 */

import { intakeFile, MAX_INTAKE_BYTES } from './intake.js'
import { loadOverlay, mergeConfig, peekOverlay, saveOverlay } from './persist.js'

const MAX_BODY = 32 * 1024

function header(headers, name) {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isTrustedRequest(req) {
  const host = header(req.headers, 'host')
  if (!host) return false
  const hostUrl = parseAuthority(host)
  if (!hostUrl || !isLoopbackHostname(hostUrl.hostname)) return false
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) {
    // Browser POST always sends Origin. Missing Origin is curl/scripts:
    // allow GET (read), refuse writes.
    return req.method === 'GET'
  }
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {() => Record<string, unknown>} getLive
 */
export function registerSettingsApi(ctx, getLive) {
  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx.webServer
    if (!webServer || typeof webServer.register !== 'function') return
    wctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/dsh-eyes',
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) {
          return json(res, 403, { ok: false, error: 'forbidden' })
        }
        const pathname = (req.url || '').split('?')[0]
        try {
          if (pathname === '/dsh-eyes/config' && req.method === 'GET') {
            await loadOverlay()
            return json(res, 200, {
              ok: true,
              config: mergeConfig(getLive() || {}),
              overlay: peekOverlay(),
            })
          }
          if (pathname === '/dsh-eyes/config' && req.method === 'POST') {
            const raw = await readBody(req, MAX_BODY)
            const body = JSON.parse(raw || '{}')
            const overlay = await saveOverlay(body)
            return json(res, 200, {
              ok: true,
              config: mergeConfig(getLive() || {}),
              overlay,
            })
          }
          if (pathname === '/dsh-eyes/intake' && req.method === 'POST') {
            const raw = await readBody(req, MAX_INTAKE_BYTES)
            const body = JSON.parse(raw || '{}')
            const result = await intakeFile(wctx, mergeConfig(getLive() || {}), body)
            return json(res, 200, result)
          }
          return json(res, 404, { ok: false, error: 'not found' })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const status = /too large/.test(message) ? 413 : 400
          return json(res, status, { ok: false, error: message })
        }
      },
    }))
  })
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > maxBytes) {
        done = true
        req.resume()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (done) return
      reject(error)
    })
  })
}

export { isTrustedRequest, isLoopbackHostname }
