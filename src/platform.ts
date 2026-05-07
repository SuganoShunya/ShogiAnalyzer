import { Capacitor } from '@capacitor/core'

export function isNativePlatform() {
  return Capacitor.isNativePlatform()
}

export function canUseServerApis() {
  return !isNativePlatform()
}
