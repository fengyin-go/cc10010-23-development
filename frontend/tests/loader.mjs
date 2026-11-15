// 测试专用解析钩子：让 Node 原生 ESM + 类型剥离能直接跑 Vite 风格的源码
// （扩展名省略、@/ 指向 src/），不引入任何第三方依赖。
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const base = resolvePath(dirname(fileURLToPath(import.meta.url)), '../src')
    const candidate = resolvePath(base, specifier.slice(2))
    const withExt = existsSync(`${candidate}.ts`) ? `${candidate}.ts` : candidate
    return nextResolve(pathToFileURL(withExt).href, context)
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parentDir = dirname(context.parentURL ? fileURLToPath(context.parentURL) : '')
    const candidate = resolvePath(parentDir, specifier)
    if (!existsSync(candidate) && existsSync(`${candidate}.ts`)) {
      return nextResolve(pathToFileURL(`${candidate}.ts`).href, context)
    }
  }
  return nextResolve(specifier, context)
}
