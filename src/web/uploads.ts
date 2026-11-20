import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MB } from '../contracts/attachments.js'
import type { MessageAttachment } from '../contracts/attachments.js'
import { HttpError } from '../http.js'

export const UPLOAD_TYPE = 'application/octet-stream'
export const UPLOAD_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/

const METADATA = '.metadata.json'

function fileName(header: string | string[] | undefined): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(typeof header === 'string' ? header : '')
  } catch {
    throw new HttpError(400, 'Invalid file name')
  }
  const name = decoded
    .split(/[/\\]/)
    .at(-1)
    // eslint-disable-next-line no-control-regex -- Strip ASCII control characters from filenames.
    ?.replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
  if (!name || name === '.' || name === '..' || Buffer.byteLength(name) > 255) throw new HttpError(400, 'Invalid file name')
  return name
}

function diskName(name: string): string {
  const safe = name.replace(/[<>:"|?*]/g, '_').replace(/^\.+|[. ]+$/g, '')
  return /^(con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])\s*(?:\.|$)/i.test(safe) ? `_${safe}` : safe || 'file'
}

function sizeError(): HttpError {
  return new HttpError(413, `Each file must be ${MAX_ATTACHMENT_MB} MB or smaller`)
}

export class Uploads {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  async save(req: IncomingMessage): Promise<{ id: string }> {
    if (Number(req.headers['content-length']) > MAX_ATTACHMENT_BYTES) throw sizeError()
    const name = fileName(req.headers['x-file-name'])
    const mime = req.headers['x-file-type']
    const type =
      typeof mime === 'string' && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mime) && mime.length <= 127 ? mime.toLowerCase() : UPLOAD_TYPE
    const id = randomUUID()
    const folder = join(this.root, id)
    const path = join(folder, diskName(name))
    await mkdir(this.root, { recursive: true })
    if (!(await lstat(this.root)).isDirectory()) throw new HttpError(500, 'Uploads folder is unavailable')
    await mkdir(folder)
    const metadata = join(folder, METADATA)
    try {
      let size = 0
      const file = await open(path, 'wx')
      try {
        for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
          size += chunk.length
          if (size > MAX_ATTACHMENT_BYTES) throw sizeError()
          await file.writeFile(chunk)
        }
      } finally {
        await file.close()
      }
      await writeFile(metadata, JSON.stringify({ name, type, size }), { flag: 'wx' })
      return { id }
    } catch (error) {
      await unlink(metadata).catch(() => {})
      await unlink(path).catch(() => {})
      await rmdir(folder).catch(() => {})
      throw error
    }
  }

  async get(id: string): Promise<MessageAttachment | null> {
    if (!UPLOAD_ID.test(id)) return null
    const folder = join(this.root, id)
    const metadata = join(folder, METADATA)
    try {
      if (!(await lstat(this.root)).isDirectory() || !(await lstat(folder)).isDirectory() || !(await lstat(metadata)).isFile()) return null
      const { name, type, size } = JSON.parse(await readFile(metadata, 'utf8')) as Omit<MessageAttachment, 'id' | 'path'>
      const path = join(folder, diskName(fileName(encodeURIComponent(name))))
      const file = await lstat(path)
      return file.isFile() && file.size === size ? { id, name, type, size, path } : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async serve(res: ServerResponse, attachment: MessageAttachment): Promise<void> {
    const file = await open(attachment.path, 'r')
    const disposition = attachment.type.startsWith('image/') ? 'inline' : 'attachment'
    const name = encodeURIComponent(attachment.name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16)}`)
    res.writeHead(200, {
      'Content-Type': attachment.type,
      'Content-Length': attachment.size,
      'Content-Disposition': `${disposition}; filename*=UTF-8''${name}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    })
    await pipeline(file.createReadStream(), res)
  }
}
