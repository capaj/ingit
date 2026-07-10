import { describe, expect, test } from 'bun:test'
import {
  assessWindowCalls,
  parseWindowCallsExtensionInfo,
} from '../src/window-calls-state.js'

const UUID = 'window-calls@domandoman.xyz'

describe('Window Calls state', () => {
  test('parses an installed and enabled extension', () => {
    const stdout = `({'uuid': <'${UUID}'>, 'state': <1.0>, 'enabled': <true>},)`
    expect(parseWindowCallsExtensionInfo(stdout, UUID)).toEqual({
      installed: true,
      enabled: true,
    })
  })

  test('parses GNOME empty extension info as not installed', () => {
    expect(parseWindowCallsExtensionInfo('(@a{sv} {},)', UUID)).toEqual({
      installed: false,
      enabled: false,
    })
  })

  test('does not offer reinstall for installed or unknown states', () => {
    expect(assessWindowCalls(false, { installed: true, enabled: false }, true)).toEqual({
      canUseOrRepair: true,
      canInstall: false,
    })
    expect(assessWindowCalls(false, null, true)).toEqual({
      canUseOrRepair: false,
      canInstall: false,
    })
  })

  test('offers install only when GNOME confirms the extension is absent', () => {
    expect(assessWindowCalls(false, { installed: false, enabled: false }, true)).toEqual({
      canUseOrRepair: false,
      canInstall: true,
    })
  })
})
