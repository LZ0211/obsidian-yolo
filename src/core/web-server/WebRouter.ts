// eslint-disable-next-line import/no-nodejs-modules -- type-only import，编译后消失，无运行时 node 依赖
import type { IncomingMessage, ServerResponse } from 'node:http'

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>

type Route = {
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: RouteHandler
}

export class WebRouter {
  private readonly routes: Route[] = []

  get(path: string, handler: RouteHandler): void {
    this.addRoute('GET', path, handler)
  }

  post(path: string, handler: RouteHandler): void {
    this.addRoute('POST', path, handler)
  }

  put(path: string, handler: RouteHandler): void {
    this.addRoute('PUT', path, handler)
  }

  delete(path: string, handler: RouteHandler): void {
    this.addRoute('DELETE', path, handler)
  }

  resolve(
    method: string,
    url: string,
  ): { handler: RouteHandler; params: Record<string, string> } | null {
    const pathname = url.split('?')[0] ?? ''
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue
      const match = route.pattern.exec(pathname)
      if (!match) continue
      const params: Record<string, string> = {}
      route.paramNames.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1] ?? '')
      })
      return { handler: route.handler, params }
    }
    return null
  }

  private addRoute(
    method: string,
    routePath: string,
    handler: RouteHandler,
  ): void {
    const paramNames: string[] = []
    const pattern = routePath
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          paramNames.push(segment.slice(1))
          return '([^/]+)'
        }
        return escapeRegExp(segment)
      })
      .join('/')
    this.routes.push({
      method,
      pattern: new RegExp(`^${pattern}$`),
      paramNames,
      handler,
    })
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
