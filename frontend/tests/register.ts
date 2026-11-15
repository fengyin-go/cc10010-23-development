// Node 测试入口：注册解析钩子，让扩展名省略与 @/ 别名的源码可以直接被原生 ESM 加载。
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

register(pathToFileURL(resolve(import.meta.dirname, 'loader.mjs')).href)
