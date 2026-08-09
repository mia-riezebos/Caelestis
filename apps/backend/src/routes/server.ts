import type { ServerInfo } from '@wts/shared'
import { Hono } from 'hono'

export const createServerRoutes = (server: ServerInfo) => {
  const routes = new Hono()
  routes.get('/', (c) => c.json(server))
  return routes
}
