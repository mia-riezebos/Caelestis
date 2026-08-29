// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { findWplaceRail, findWplaceRightControls } from './wplace-rail.js'

const nativeButton = (title: string): HTMLButtonElement => {
  const button = document.createElement('button')
  button.title = title
  return button
}

beforeEach(() => document.body.replaceChildren())

describe('Wplace rail discovery', () => {
  it('finds the logged-out Leaderboard and Search rail', () => {
    const accountControls = document.createElement('div')
    const login = nativeButton('')
    login.textContent = 'Log in'
    const nativeRail = document.createElement('div')
    const leaderboard = nativeButton('Leaderboard')
    const search = nativeButton('Search')
    nativeRail.append(leaderboard, search)
    accountControls.append(login, nativeRail)
    document.body.append(accountControls)

    expect(findWplaceRail()).toBe(nativeRail)
    expect(findWplaceRightControls()).toBe(accountControls)
  })

  it('prefers the Overlays rail when logged in', () => {
    const loggedOutRail = document.createElement('div')
    loggedOutRail.append(nativeButton('Search'))
    const loggedInRail = document.createElement('div')
    const overlays = nativeButton('Overlays')
    loggedInRail.append(overlays)
    document.body.append(loggedOutRail, loggedInRail)

    expect(findWplaceRail()).toBe(loggedInRail)
  })
})
