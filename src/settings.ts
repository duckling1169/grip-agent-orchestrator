import { EventEmitter } from 'node:events'

import { readConfigFile } from './config.js'
import type { MoxySettings } from './contracts/api.js'
import { QuotaRefreshMinutes } from './contracts/settings.js'
import { writeFileAtomic } from './files.js'

export class Settings extends EventEmitter<{ change: [MoxySettings] }> {
  private saving: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly path: string,
    private value: MoxySettings,
  ) {
    super()
  }

  current(): MoxySettings {
    return { ...this.value }
  }

  update(value: MoxySettings): Promise<MoxySettings> {
    const minutes = value.quotaRefreshMinutes
    if (!QuotaRefreshMinutes.safeParse(minutes).success)
      return Promise.reject(new Error('quotaRefreshMinutes must be 0 (off) or whole minutes from 1 to 1440'))
    const save = this.saving.then(async () => {
      const raw = await readConfigFile(this.path)
      await writeFileAtomic(this.path, `${JSON.stringify({ ...raw, quotaRefreshMinutes: minutes }, null, 2)}\n`)
      this.value = { quotaRefreshMinutes: minutes }
      this.emit('change', this.current())
      return this.current()
    })
    this.saving = save.catch(() => undefined)
    return save
  }
}
