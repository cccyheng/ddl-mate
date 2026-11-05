#!/usr/bin/env node
/**
 * 生成登录密码的 PBKDF2 哈希（与后端 PasswordHasher 同算法、同参数）。
 *
 * 用法：node scripts/hash-password.mjs
 * 按提示输入两次密码（不回显），输出一行 pbkdf2$... ，填到服务器的 DDLMATE_AUTH_PASSWORD_HASH。
 * 明文密码不会写入任何文件。
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto'
import { stdin, stdout } from 'node:process'

const ITERATIONS = 210_000

function ask(prompt) {
  return new Promise((resolve) => {
    stdout.write(prompt)
    let value = ''
    const raw = stdin.isTTY
    if (raw) stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData)
          if (raw) stdin.setRawMode(false)
          stdin.pause()
          stdout.write('\n')
          resolve(value)
          return
        }
        if (ch === '\u0003') process.exit(130)
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}

const first = await ask('新密码（至少 10 位）：')
if (first.length < 10) {
  console.error('密码太短：服务器在公网上，请至少用 10 位。')
  process.exit(1)
}
const second = await ask('再输入一次：')
if (first !== second) {
  console.error('两次输入不一致。')
  process.exit(1)
}
const salt = randomBytes(16)
const key = pbkdf2Sync(first, salt, ITERATIONS, 32, 'sha256')
console.log(`pbkdf2$${ITERATIONS}$${salt.toString('base64')}$${key.toString('base64')}`)
