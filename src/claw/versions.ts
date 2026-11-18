import semver from 'semver'

export const CLAW_PACKAGE = '@enderfga/claw-orchestrator'

/** Every 7.x from the trialled release on; a new major waits for the user's approval. */
export const CLAW_RANGE = '>=7.23.4 <8'

function releases(available: readonly string[]): string[] {
  return available.filter(v => semver.valid(v) && !semver.prerelease(v))
}

/** The newest release inside the range, or null when none is published. */
export function pickTarget(available: readonly string[], range = CLAW_RANGE): string | null {
  return semver.maxSatisfying(releases(available), range)
}

/** The newest release above the range: a new major waiting for approval, or null. */
export function pendingMajor(available: readonly string[], range = CLAW_RANGE): string | null {
  const above = releases(available).filter(v => semver.gtr(v, range))
  return above.length ? semver.rsort(above)[0]! : null
}

export function inRange(version: string | null | undefined, range = CLAW_RANGE): version is string {
  return !!version && !!semver.valid(version) && semver.satisfies(version, range)
}

export function isNewer(candidate: string, current: string | null | undefined): boolean {
  return !current || !semver.valid(current) || semver.gt(candidate, current)
}
