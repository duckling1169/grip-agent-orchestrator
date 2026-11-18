import { existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(moduleDir, '../..')
// The compiled server lives under dist/src/web; the source server lives under src/web.
export const DEFAULT_STATIC_DIR = resolve(
  existsSync(resolve(sourceRoot, 'package.json')) ? sourceRoot : resolve(sourceRoot, '..'),
  'web/dist',
)

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

/** Serve only files beneath the build directory. Caller must authenticate the request first. */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, staticDir = DEFAULT_STATIC_DIR): Promise<void> {
  const rawPath = (req.url ?? '/').split('?')[0]!
  let path: string
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    return reply(res, req, 400, 'Bad request')
  }
  // Inspect the original path before URL normalization, including encoded separators and dots.
  if (!path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.'))
    return reply(res, req, 404, 'Not found')

  let root: string
  try {
    root = await realpath(staticDir)
  } catch {
    return path === '/' ? unavailable(res, req) : reply(res, req, 404, 'Not found')
  }

  const name = path === '/' ? 'index.html' : path.slice(1)
  const candidate = resolve(root, name)
  const within = (target: string) => {
    const rel = relative(root, target)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  }
  if (!within(candidate)) return reply(res, req, 404, 'Not found')
  let file: string
  try {
    file = await realpath(candidate)
    if (!within(file) || !(await stat(file)).isFile()) return reply(res, req, 404, 'Not found')
  } catch {
    return path === '/' ? unavailable(res, req) : reply(res, req, 404, 'Not found')
  }
  const type = mime[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const content = await readFile(file)
  const immutable = name.startsWith('assets/') && /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(basename(name))
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': content.length,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(req.method === 'HEAD' ? undefined : content)
}

function reply(res: ServerResponse, req: IncomingMessage, status: number, body: string, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function unavailable(res: ServerResponse, req: IncomingMessage) {
  return reply(
    res,
    req,
    503,
    '<!doctype html><title>Grip unavailable</title><h1>Web app not built</h1><p>Build the Grip web app and reload.</p>',
    'text/html; charset=utf-8',
  )
}
