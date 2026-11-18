import { expect, it } from 'vitest'

import { listMachines } from './machines.js'

const status = {
  Self: {
    HostName: 'Workstation',
    DNSName: 'windows-pc.tail.ts.net.',
    OS: 'windows',
    Online: true,
    TailscaleIPs: ['fd7a::1', '100.1.1.1'],
  },
  Peer: {
    a: { HostName: 'iphone', DNSName: 'iphone.tail.ts.net.', OS: 'iOS', Online: true, TailscaleIPs: ['100.1.1.2'] },
    b: { HostName: 'mac', DNSName: 'macbook-air.tail.ts.net.', OS: 'macOS', Online: true, TailscaleIPs: ['100.1.1.3'] },
    c: { HostName: 'box', DNSName: 'linux-box.tail.ts.net.', OS: 'linux', Online: true, TailscaleIPs: ['100.1.1.4'] },
    d: { HostName: 'old', DNSName: 'old-pc.tail.ts.net.', OS: 'windows', Online: false, TailscaleIPs: ['100.1.1.5'] },
  },
}

it('lists this machine first, then machines running Grip, asking only online computers', async () => {
  const asked: string[] = []
  const list = await listMachines({
    exec: async () => ({ code: 0, stdout: JSON.stringify(status), stderr: '' }),
    probe: async url => {
      asked.push(url)
      return url.includes('linux-box')
    },
  })
  expect(asked.sort()).toEqual(['https://linux-box.tail.ts.net/', 'https://macbook-air.tail.ts.net/'])
  expect(list.machines.map(m => [m.name, m.grip, m.url])).toEqual([
    ['windows-pc', 'yes', 'https://windows-pc.tail.ts.net/'],
    ['linux-box', 'yes', 'https://linux-box.tail.ts.net/'],
    ['iphone', 'no', null],
    ['macbook-air', 'no', null],
    ['old-pc', 'unknown', null],
  ])
  expect(list.machines[0]).toMatchObject({ self: true, online: true, ips: ['100.1.1.1', 'fd7a::1'], os: 'windows' })
})

it('says why when Tailscale cannot be read', async () => {
  await expect(listMachines({ exec: async () => ({ code: 1, stdout: '', stderr: 'not running\n' }) })).rejects.toThrow(
    'tailscale status: not running',
  )
})
