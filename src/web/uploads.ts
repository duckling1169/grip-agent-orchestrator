import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MB, MAX_ATTACHMENTS } from '../contracts/attachments.js'
import type { MessageAttachment } from '../contracts/attachments.js'
import { HttpError } from '../http.js'

export const UPLOAD_TYPE = 'application/octet-stream'
export const UPLOAD_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/

const METADATA = '.metadata.json'
const DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1000
const DRAFT_BUDGET_BYTES = MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES
const BODY_DEADLINE_MS = 60_000

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
  private readonly drafts = new Map<string, { size: number; expiresAt: number }>()
  private draftBytes = 0
  private operations = Promise.resolve()

  constructor(
    root: string,
    private readonly budgetBytes = DRAFT_BUDGET_BYTES,
    private readonly deadlineMs = BODY_DEADLINE_MS,
  ) {
    this.root = resolve(root)
  }

  async initialize(referenced: ReadonlySet<string>): Promise<void> {
    await mkdir(this.root, { recursive: true })
    if (!(await lstat(this.root)).isDirectory()) throw new Error('Uploads folder is unavailable')
    for (const folder of await readdir(this.root, { withFileTypes: true })) {
      const id = folder.name
      if (!folder.isDirectory() || !UPLOAD_ID.test(id) || referenced.has(id)) continue
      const path = join(this.root, id)
      const expiresAt = (await lstat(path)).mtimeMs + DRAFT_LIFETIME_MS
      let size = 0
      for (const file of await readdir(path, { withFileTypes: true })) {
        if (file.isFile() && file.name !== METADATA) size += (await lstat(join(path, file.name))).size
      }
      this.drafts.set(id, { size, expiresAt })
      this.draftBytes += size
    }
    await this.sweep()
  }

  attach<T extends { received: boolean }>(ids: string[], receive: (files: MessageAttachment[]) => T): Promise<T> {
    return this.inOrder(async () => {
      const files = await Promise.all(
        ids.map(async id => {
          const file = await this.get(id)
          if (!file) throw new HttpError(404, `Attachment ${id} was not found. Upload it again.`)
          return file
        }),
      )
      const result = receive(files)
      if (result.received) for (const id of ids) this.clearDraft(id)
      return result
    })
  }

  private sweep(): Promise<void> {
    return this.inOrder(async () => {
      const now = Date.now()
      for (const [id, { expiresAt }] of this.drafts) {
        if (expiresAt > now) continue
        await rm(join(this.root, id), { recursive: true, force: true })
        this.clearDraft(id)
      }
    })
  }

  private inOrder<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.then(operation)
    this.operations = next.then(
      () => {},
      () => {},
    )
    return next
  }

  private clearDraft(id: string): void {
    this.draftBytes -= this.drafts.get(id)?.size ?? 0
    this.drafts.delete(id)
  }

  async save(req: IncomingMessage): Promise<{ id: string }> {
    const deadline = performance.now() + this.deadlineMs
    if (Number(req.headers['content-length']) > MAX_ATTACHMENT_BYTES) throw sizeError()
    const name = fileName(req.headers['x-file-name'])
    const mime = req.headers['x-file-type']
    const type =
      typeof mime === 'string' && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mime) && mime.length <= 127 ? mime.toLowerCase() : UPLOAD_TYPE
    const id = randomUUID()
    const folder = join(this.root, id)
    const path = join(folder, diskName(name))
    if (!(await lstat(this.root)).isDirectory()) throw new Error('Uploads folder is unavailable')
    await this.sweep()
    await mkdir(folder)
    const metadata = join(folder, METADATA)
    let size = 0
    try {
      const file = await open(path, 'wx')
      try {
        await readUpload(req, deadline, async chunk => {
          if (size + chunk.length > MAX_ATTACHMENT_BYTES) throw sizeError()
          if (this.draftBytes + chunk.length > this.budgetBytes) {
            throw new HttpError(413, 'Draft upload storage is full. Send existing drafts or wait for them to expire.')
          }
          size += chunk.length
          this.draftBytes += chunk.length
          await file.writeFile(chunk)
        })
      } finally {
        await file.close()
      }
      await writeFile(metadata, JSON.stringify({ name, type, size }), { flag: 'wx' })
      this.drafts.set(id, { size, expiresAt: Date.now() + DRAFT_LIFETIME_MS })
      return { id }
    } catch (error) {
      await rm(folder, { recursive: true, force: true })
      this.draftBytes -= size
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

async function readUpload(req: IncomingMessage, deadline: number, write: (chunk: Buffer) => Promise<void>): Promise<void> {
  const expired = new HttpError(408, 'Upload took too long. Try again.')
  const remaining = deadline - performance.now()
  if (remaining <= 0) throw expired
  if (req.destroyed) throw new HttpError(400, 'Upload disconnected')
  const stream = new PassThrough()
  const forwardError = (error: Error) => stream.destroy(error)
  const timer = setTimeout(() => stream.destroy(expired), remaining)
  req.once('error', forwardError)
  req.pipe(stream)
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) await write(chunk)
  } finally {
    clearTimeout(timer)
    req.unpipe(stream)
    req.off('error', forwardError)
  }
}
