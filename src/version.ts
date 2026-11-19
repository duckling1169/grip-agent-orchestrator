import { createRequire } from 'node:module'

export const MOXY_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version
