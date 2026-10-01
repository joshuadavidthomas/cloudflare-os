// The browser half of the gatekeeper connect handoff (see `GatekeeperVendor.connectAccount` in
// workshop-shared). A connect URL is a bearer capability, so the Workshop opens it as a disowned
// popup carrying the flow's nonce in the popup's own sessionStorage. When the flow finishes, the
// gatekeeper's final page navigates that popup to HANDOFF_PATH on this origin with the single-use
// ticket in the URL fragment, and ConnectHandoffPage redeems ticket and nonce together over the
// popup's own session. Redeeming is what activates the grant.

import type { ConnectFlowStart } from '@gadgets/workshop-shared/api'

/** Host the backend (and, through the router, every gatekeeper) is served from. */
export function getBackendHost(): string {
  // Only the Vite dev server is hosted separately from the backend. Built assets are served from
  // the same origin in both production and run-local mode.
  if (import.meta.env.DEV) {
    return import.meta.env.VITE_BACKEND_HOST?.trim() || 'localhost:8787'
  }
  return window.location.host
}

/**
 * Path on the Workshop origin a finished connect / sign-in popup lands on, with the ticket in the
 * URL fragment. gatekeeper-kit duplicates the literal, since it must not depend on this package;
 * each package pins it with a test.
 */
export const HANDOFF_PATH = '/connect/handoff'

const HEX_256_PATTERN = /^[0-9a-f]{64}$/

/**
 * The ticket a handoff URL fragment carries (`window.location.hash`, with or without its leading
 * '#', percent-encoded or not), or null unless it decodes to 64 lowercase hex characters.
 */
export function ticketFromHandoffFragment(hash: string): string | null {
  const encoded = hash.startsWith('#') ? hash.slice(1) : hash
  let ticket: string
  try {
    ticket = decodeURIComponent(encoded)
  } catch {
    return null
  }
  return HEX_256_PATTERN.test(ticket) ? ticket : null
}

/** sessionStorage key under which the Workshop writes a `PopupHandoff` into a popup it opened. */
export const HANDOFF_KEY = 'gadgets.handoff'

/**
 * The record the Workshop tab writes into a popup's own sessionStorage before navigating it: which
 * kind of flow the popup runs, and the flow's nonce, which the handoff page presents with the
 * ticket (`completeConnectHandoff` for a connect, `confirmLogin` for a sign-in).
 */
export type PopupHandoff = { kind: 'connect' | 'login'; nonce: string }

/**
 * Opens `url` as a popup that holds `handoff` and nothing else of this tab. The popup is opened
 * empty (a same-origin about:blank, so its sessionStorage is ours to write), disowned, given the
 * nonce, and only then navigated, so no page in the flow ever holds `window.opener`: a connect flow
 * can land on pages the deployment does not vouch for (an MCP server the user pasted, say), and an
 * opener handle would let such a page navigate this authenticated tab to a phishing page (reverse
 * tabnabbing). With no opener in play the flow is also indifferent to a provider isolating its
 * pages with COOP.
 *
 * The nonce goes into the popup's storage, not this tab's: it then exists only on the server and
 * in that popup, nothing opened from this tab inherits it, and a handoff link opened any other way
 * (a fresh tab, a pasted URL, a link an attacker sends) holds none and redeems nothing.
 *
 * Throws when the browser blocked the popup, or refused the storage write: without the nonce the
 * flow could never complete, so it is not started, and the popup is closed again.
 */
export function openDisownedPopup(url: string, name: string, handoff: PopupHandoff): Window {
  const popup = openBlankPopup(name)
  handOffPopup(popup, url, handoff)
  return popup
}

/**
 * The first half of `openDisownedPopup`: an empty, disowned popup, opened now so that it is still
 * the user's click opening it. Safari only lets a page open a window while it is handling the
 * click, and an `await` ends that, so a flow whose URL comes from the server opens its popup
 * before asking for the URL and navigates it with `handOffPopup` once it arrives.
 *
 * Disowning is done by hand rather than with the `noopener` feature, which makes `window.open()`
 * return null even on success, indistinguishable from a pop-up block. `name` must be fresh per
 * flow: `window.open('', existingName)` returns an existing window without navigating it, and one
 * parked on a provider page is cross-origin, so the storage write would throw.
 */
function openBlankPopup(name: string): Window {
  const popup = window.open('', name, 'popup,width=520,height=680')
  if (!popup) throw new Error('Pop-up blocked. Please allow pop-ups and try again.')
  popup.opener = null
  return popup
}

/** The second half of `openDisownedPopup`: gives the blank popup the nonce, then navigates it. */
function handOffPopup(popup: Window, url: string, handoff: PopupHandoff): void {
  try {
    popup.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff))
  } catch {
    popup.close()
    throw new Error('This browser blocks storage in pop-ups, so the flow cannot complete. Allow site data for this site and try again.')
  }
  popup.location.replace(url)
}

/**
 * A window name no popup this origin still has open can share: `<prefix>-<uuid>`. A per-document
 * counter would restart on reload while an earlier disowned popup, still parked on a provider
 * page, keeps its name, and `window.open('', thatName)` would hand that cross-origin window back.
 */
export function uniquePopupName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

// The connect popup this document opened last, closed before the next one opens: a stale popup
// still parked on a provider page is otherwise left behind the new one.
let lastConnectPopup: Window | null = null

/**
 * Opens a connect / reconnect / ensure-resources flow as a disowned popup carrying the flow's
 * nonce (see `openDisownedPopup`). The popup redeems the ticket itself on ConnectHandoffPage; the
 * account arrives in this tab through `subscribeConnectedAccounts()`.
 *
 * Takes the RPC that starts the flow un-awaited -- `await openConnectWindow(api.connectAccount(id))`
 * -- and must be called while handling the user's click: the popup opens blank straight away and
 * is navigated when the flow arrives (see `openBlankPopup`). A null flow, which
 * `ensureAccountResources` returns when the account already has the access, closes the popup
 * again and resolves null. Rejects when the browser blocked the popup or the flow failed to start,
 * closing the popup either way.
 */
export async function openConnectWindow(
  flow: ConnectFlowStart | null | Promise<ConnectFlowStart | null>,
): Promise<Window | null> {
  if (lastConnectPopup) {
    try { lastConnectPopup.close() } catch { /* cross-origin or already gone */ }
    lastConnectPopup = null
  }
  let popup: Window
  try {
    popup = openBlankPopup(uniquePopupName('gadgets-connect'))
  } catch (error) {
    // The flow was started regardless; nothing will redeem it, so it just expires.
    Promise.resolve(flow).catch(() => {})
    throw error
  }
  let started: ConnectFlowStart | null
  try {
    started = await flow
  } catch (error) {
    popup.close()
    throw error
  }
  if (!started) {
    popup.close()
    return null
  }
  handOffPopup(popup, started.url, { kind: 'connect', nonce: started.nonce })
  lastConnectPopup = popup
  return popup
}

/**
 * The `PopupHandoff` the Workshop tab wrote into this document's sessionStorage, removed as it is
 * read (single-use on the client as well as the server), or null when there is none, it is
 * malformed, or storage is unavailable.
 */
export function readPopupHandoff(): PopupHandoff | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(HANDOFF_KEY)
    sessionStorage.removeItem(HANDOFF_KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { kind, nonce } = parsed as { kind?: unknown; nonce?: unknown }
  if (kind !== 'connect' && kind !== 'login') return null
  if (typeof nonce !== 'string' || !HEX_256_PATTERN.test(nonce)) return null
  return { kind, nonce }
}
