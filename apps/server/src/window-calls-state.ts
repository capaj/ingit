export interface WindowCallsExtensionInfo {
  installed: boolean
  enabled: boolean
}

/**
 * Parse the small part of GetExtensionInfo's GVariant text output that ingit
 * needs. An empty dictionary means the UUID is not installed.
 */
export function parseWindowCallsExtensionInfo(
  stdout: string,
  uuid: string,
): WindowCallsExtensionInfo | null {
  const compact = stdout.trim()
  if (/^\(@?a?\{sv\}\s*\{\},\)$/.test(compact) || compact === '({},)') {
    return { installed: false, enabled: false }
  }
  if (!compact.includes(`'uuid': <'${uuid}'>`)) return null
  return {
    installed: true,
    enabled: compact.includes("'enabled': <true>"),
  }
}

export function assessWindowCalls(
  endpointAvailable: boolean,
  extensionInfo: WindowCallsExtensionInfo | null,
  isGnome: boolean,
): { canUseOrRepair: boolean; canInstall: boolean } {
  // A failed/unknown info query must never lead to a blind reinstall: that is
  // how an already-active extension ended up with a duplicate D-Bus export.
  const installed = endpointAvailable || extensionInfo?.installed === true
  return {
    canUseOrRepair: installed,
    canInstall: isGnome && extensionInfo?.installed === false,
  }
}
