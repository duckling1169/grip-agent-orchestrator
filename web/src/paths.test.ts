import { expect, it } from 'vitest'

import { pathTrail } from './paths.js'

it('splits Windows and POSIX paths into tappable parts', () => {
  expect(pathTrail('C:\\Users\\you')).toEqual([
    { name: 'C:', path: 'C:\\' },
    { name: 'Users', path: 'C:\\Users' },
    { name: 'Adam', path: 'C:\\Users\\you' },
  ])
  expect(pathTrail('D:\\')).toEqual([{ name: 'D:', path: 'D:\\' }])
  expect(pathTrail('/home/you')).toEqual([
    { name: '/', path: '/' },
    { name: 'home', path: '/home' },
    { name: 'adam', path: '/home/you' },
  ])
})
