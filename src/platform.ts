import { Capacitor } from '@capacitor/core'

export function isNativePlatform() {
  return Capacitor.isNativePlatform()
}

export function isHostedWebApp() {
  if (typeof window === 'undefined') return false
  const { hostname, protocol } = window.location
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1'
  const isLanIp = /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
  return protocol.startsWith('http') && !isLocalHost && !isLanIp
}

export function canUseServerApis() {
  return !isNativePlatform()
}
