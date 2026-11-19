const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function clockTime(iso: string): string {
  const date = new Date(iso)
  return date.toDateString() === new Date().toDateString() ? time.format(date) : day.format(date)
}

export function elapsed(fromIso: string, toIso: string | null): string {
  const seconds = Math.max(0, Math.round(((toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso)) / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
