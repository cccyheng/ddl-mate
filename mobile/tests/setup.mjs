/**
 * 测试启动文件：在**主线程**注册 TypeScript 无扩展名解析钩子。
 *
 * 用法（见 package.json 的 `test` 脚本）：
 *   node --import ./tests/setup.mjs --test tests/*.test.mjs
 *
 * 该文件本身不导入任何应用源码，只负责注册钩子。
 */

import { registerHooks } from 'node:module'

import { resolve } from './tsResolveHooks.mjs'

registerHooks({ resolve })
