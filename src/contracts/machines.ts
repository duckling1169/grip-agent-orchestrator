export type Machine = {
  id: string
  name: string
  dnsName: string
  self: boolean
  online: boolean
  moxy: 'yes' | 'no' | 'unknown'
  url: string | null
}

export type MachineList = { machines: Machine[]; checkedAt: string; error: string | null }
