import { useEffect } from 'react'

import { useStoredState } from '@/lib/stored'

export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

const systemDark = matchMedia('(prefers-color-scheme: dark)')

export function useTheme() {
  const [theme, setTheme] = useStoredState<Theme>('theme', stored => THEMES.find(value => value === stored) ?? 'system')
  useEffect(() => {
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && systemDark.matches))
    apply()
    systemDark.addEventListener('change', apply)
    return () => systemDark.removeEventListener('change', apply)
  }, [theme])
  return [theme, setTheme] as const
}
