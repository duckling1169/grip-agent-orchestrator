import { z } from 'zod'

export const QuotaRefreshMinutes = z.number().int().min(0).max(1440)
export const MoxySettingsBody = z.object({ quotaRefreshMinutes: QuotaRefreshMinutes })
