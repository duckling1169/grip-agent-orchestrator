export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function reportingTo(onError: (message: string) => void) {
  return (action: () => Promise<unknown>): Promise<void> =>
    action().then(
      () => undefined,
      (error: unknown) => onError(errorMessage(error)),
    )
}
