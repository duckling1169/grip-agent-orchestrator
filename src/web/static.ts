import { readFile, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_STATIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse, staticDir: string): Promise<void> {
  let path: string
  try {
    path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
  } catch {
    return reply(req, res, 400, 'Bad request')
  }
  if (!path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.')) {
    return reply(req, res, 404, 'Not found')
  }
  let root: string
  try {
    root = await realpath(staticDir)
  } catch {
    return path === '/' ? notBuilt(req, res) : reply(req, res, 404, 'Not found')
  }
  const name = path === '/' ? 'index.html' : path.slice(1)
  const within = (target: string) => {
    const rel = relative(root, target)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  }
  let file: string
  try {
    file = await realpath(resolve(root, name))
    if (!within(file) || !(await stat(file)).isFile()) return reply(req, res, 404, 'Not found')
  } catch {
    return path === '/' ? notBuilt(req, res) : reply(req, res, 404, 'Not found')
  }
  const content = await readFile(file)
  const immutable = name.startsWith('assets/') && /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(basename(name))
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(req.method === 'HEAD' ? undefined : content)
}

function reply(req: IncomingMessage, res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(req.method === 'HEAD' ? undefined : body)
}

function notBuilt(req: IncomingMessage, res: ServerResponse): void {
  reply(
    req,
    res,
    503,
    '<!doctype html><title>Moxy</title><p>The Moxy web app is not built. Run npm run build.</p>',
    'text/html; charset=utf-8',
  )
}
