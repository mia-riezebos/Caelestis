import { millis } from '@caelestis/shared'
import { D1SqlStore } from '../../src/adapters/cloudflare/d1-sql-store.js'
import { runNodeTemplateContract } from '../support/sql-contract.js'

const assertEqual = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('D1 contract assertion failed')
}

export default {
  async fetch(request: Request, env: { readonly DB: D1Database }): Promise<Response> {
    if (new URL(request.url).pathname === '/migrate') {
      for (const statement of (await request.text()).split('--> statement-breakpoint'))
        if (statement.trim()) await env.DB.prepare(statement).run()
      return new Response(null, { status: 204 })
    }
    const sql = new D1SqlStore(env.DB)
    const createdAt = millis(100)
    for (const tokenHash of ['b'.repeat(64), 'a'.repeat(64)])
      await sql.insertAccessToken({
        tokenHash,
        label: tokenHash,
        scope: 'read',
        createdWithToken: tokenHash,
        createdAt,
      })
    assertEqual(await sql.readServerSettings(), { name: null, description: null })
    await sql.writeServerSettings({ name: 'D1 server' })
    await sql.writeServerSettings({ description: 'real binding' })
    return Response.json({
      tokenHashes: (await sql.listAccessTokens()).map((token) => token.tokenHash),
      settings: await sql.readServerSettings(),
      nodeTemplate: await runNodeTemplateContract(sql),
    })
  },
}
