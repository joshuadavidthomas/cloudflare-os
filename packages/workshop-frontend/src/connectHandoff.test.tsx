// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HANDOFF_KEY, HANDOFF_PATH, openConnectWindow, readPopupHandoff, ticketFromHandoffFragment,
  uniquePopupName,
} from './connectHandoff'
import { createRouter } from './router'

const TICKET = 'a'.repeat(64)
const NONCE = 'b'.repeat(64)
const FEATURES = 'popup,width=520,height=680'

// A popup as window.open returns it: an opener pointing back at us, its own storage, and a location
// to navigate. `openerAtReplace` records what the opener was when the navigation happened.
function fakePopup() {
  const store = new Map<string, string>()
  const popup = {
    opener: window as Window | null,
    openerAtReplace: undefined as Window | null | undefined,
    close: vi.fn<() => void>(),
    sessionStorage: {
      store,
      setItem: vi.fn<(key: string, value: string) => void>((key, value) => { store.set(key, value) }),
    },
    location: {
      replace: vi.fn<(url: string) => void>(() => { popup.openerAtReplace = popup.opener }),
    },
  }
  return popup
}

describe('openConnectWindow', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it('opens an empty popup under a fresh name, disowns it, gives it the nonce, then navigates it', async () => {
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    expect(await openConnectWindow({ url: 'https://gk.example/connect', nonce: NONCE })).toBe(popup)
    expect(open).toHaveBeenCalledExactlyOnceWith('', expect.stringMatching(/^gadgets-connect-/), FEATURES)
    expect(open.mock.calls[0][1]).not.toContain('noopener')
    expect(open.mock.calls[0][2]).not.toContain('noopener')
    // Disowned before it is navigated, so no page in the flow ever sees window.opener.
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith('https://gk.example/connect')
    expect(popup.openerAtReplace).toBeNull()
    expect(popup.opener).toBeNull()
    // The nonce is written while the popup is still our about:blank, before the navigation.
    expect(popup.sessionStorage.setItem.mock.invocationCallOrder[0])
      .toBeLessThan(popup.location.replace.mock.invocationCallOrder[0])
  })

  it('writes the handoff record into the popup, and nothing into this tab', async () => {
    const popup = fakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    await openConnectWindow({ url: 'https://gk.example/connect', nonce: NONCE })

    expect(popup.sessionStorage.setItem).toHaveBeenCalledExactlyOnceWith(
      HANDOFF_KEY, JSON.stringify({ kind: 'connect', nonce: NONCE }))
    expect(JSON.parse(popup.sessionStorage.store.get(HANDOFF_KEY)!)).toEqual({ kind: 'connect', nonce: NONCE })
    expect(sessionStorage.length).toBe(0)
  })

  it('closes the previous connect popup and names the next one differently', async () => {
    const first = fakePopup()
    const second = fakePopup()
    const open = vi.spyOn(window, 'open')
      .mockReturnValueOnce(first as unknown as Window)
      .mockReturnValueOnce(second as unknown as Window)

    await openConnectWindow({ url: 'https://gk.example/one', nonce: NONCE })
    expect(first.close).not.toHaveBeenCalled()
    await openConnectWindow({ url: 'https://gk.example/two', nonce: 'c'.repeat(64) })

    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
    expect(open.mock.calls[0][1]).not.toBe(open.mock.calls[1][1])
    expect(second.location.replace).toHaveBeenCalledExactlyOnceWith('https://gk.example/two')
  })

  it('tells the user when the browser blocked the popup', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)

    await expect(openConnectWindow({ url: 'https://gk.example/connect', nonce: NONCE }))
      .rejects.toThrow('Pop-up blocked. Please allow pop-ups and try again.')
  })

  it('closes the popup and throws when it refuses the storage write, starting nothing', async () => {
    // Without the nonce the flow could never complete, so the user hears it now, not after the
    // provider's consent screen.
    const popup = fakePopup()
    popup.sessionStorage.setItem.mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    await expect(openConnectWindow({ url: 'https://gk.example/connect', nonce: NONCE }))
      .rejects.toThrow(/blocks storage in pop-ups/)
    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.location.replace).not.toHaveBeenCalled()
  })

  // Safari only lets a page open a window while it handles the click; once the handler awaits the
  // RPC that starts the flow, window.open() is blocked. So the popup has to open first.
  it('opens the popup before the flow arrives, then navigates it once it does', async () => {
    const popup = fakePopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    let resolveFlow!: (flow: { url: string; nonce: string }) => void

    const opening = openConnectWindow(new Promise(resolve => { resolveFlow = resolve }))
    expect(open).toHaveBeenCalledOnce()
    expect(popup.opener).toBeNull()
    expect(popup.location.replace).not.toHaveBeenCalled()

    resolveFlow({ url: 'https://gk.example/connect', nonce: NONCE })
    expect(await opening).toBe(popup)
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith('https://gk.example/connect')
    expect(popup.close).not.toHaveBeenCalled()
  })

  it('closes the popup when the flow fails to start', async () => {
    const popup = fakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    await expect(openConnectWindow(Promise.reject(new Error('No such service: x'))))
      .rejects.toThrow('No such service: x')
    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.location.replace).not.toHaveBeenCalled()
  })

  it('closes the popup and resolves null when there is no flow to run', async () => {
    // ensureAccountResources returns null when the account already has the access.
    const popup = fakePopup()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)

    expect(await openConnectWindow(Promise.resolve(null))).toBeNull()
    expect(popup.close).toHaveBeenCalledOnce()
    expect(popup.location.replace).not.toHaveBeenCalled()
  })

  it('reports a blocked popup rather than the flow, which it leaves to expire', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)

    await expect(openConnectWindow(Promise.reject(new Error('also failed'))))
      .rejects.toThrow('Pop-up blocked. Please allow pop-ups and try again.')
  })
})

describe('uniquePopupName', () => {
  it('names each popup with a random suffix, not a counter', () => {
    const first = uniquePopupName('gadgets-connect')
    const second = uniquePopupName('gadgets-connect')
    expect(first).toMatch(/^gadgets-connect-[0-9a-f-]{36}$/)
    expect(second).toMatch(/^gadgets-connect-[0-9a-f-]{36}$/)
    expect(second).not.toBe(first)
  })
})

describe('readPopupHandoff', () => {
  afterEach(() => { sessionStorage.clear() })

  it('returns the record and removes it', () => {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ kind: 'login', nonce: NONCE }))

    expect(readPopupHandoff()).toEqual({ kind: 'login', nonce: NONCE })
    expect(sessionStorage.getItem(HANDOFF_KEY)).toBeNull()
    expect(readPopupHandoff()).toBeNull()
  })

  it.each([
    ['malformed JSON', '{kind:'],
    ['an unknown kind', JSON.stringify({ kind: 'reconnect', nonce: NONCE })],
    ['a non-hex nonce', JSON.stringify({ kind: 'connect', nonce: 'g'.repeat(64) })],
    ['an uppercase nonce', JSON.stringify({ kind: 'connect', nonce: 'B'.repeat(64) })],
    ['a short nonce', JSON.stringify({ kind: 'connect', nonce: 'b'.repeat(63) })],
    ['a missing nonce', JSON.stringify({ kind: 'connect' })],
    ['a non-object', JSON.stringify('connect')],
  ])('returns null and removes the key for %s', (_label, stored) => {
    sessionStorage.setItem(HANDOFF_KEY, stored)

    expect(readPopupHandoff()).toBeNull()
    expect(sessionStorage.getItem(HANDOFF_KEY)).toBeNull()
  })

  it('returns null when nothing is stored', () => {
    expect(readPopupHandoff()).toBeNull()
  })
})

describe('ticketFromHandoffFragment', () => {
  it('accepts a 64-hex ticket with or without the leading #', () => {
    expect(ticketFromHandoffFragment(`#${TICKET}`)).toBe(TICKET)
    expect(ticketFromHandoffFragment(TICKET)).toBe(TICKET)
  })

  it('decodes a percent-encoded ticket', () => {
    expect(ticketFromHandoffFragment(`#${encodeURIComponent(TICKET)}`)).toBe(TICKET)
    expect(ticketFromHandoffFragment(`#%61${'a'.repeat(63)}`)).toBe(TICKET)
  })

  it.each([
    ['uppercase hex', `#${TICKET.toUpperCase()}`],
    ['63 characters', `#${'a'.repeat(63)}`],
    ['65 characters', `#${'a'.repeat(65)}`],
    ['a malformed escape', '#%zz'],
    ['an empty string', ''],
    ['a bare #', '#'],
  ])('rejects %s', (_label, hash) => {
    expect(ticketFromHandoffFragment(hash)).toBeNull()
  })
})

describe('HANDOFF_PATH', () => {
  it('is the path the kit navigates a finished popup to, and one the SPA routes', () => {
    expect(HANDOFF_PATH).toBe('/connect/handoff')
    // The real route tree, so a renamed or missing routes/connect.handoff.tsx fails here.
    expect(createRouter().routesByPath[HANDOFF_PATH]).toBeDefined()
  })
})
