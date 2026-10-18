import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Credentials (OAuth tokens, app passwords, bot token) are encrypted with AES-256-GCM.
 * The key lives outside the database: PLANNING_SECRET_KEY or a 0600 key file next to it.
 */
export class SecretBox {
  private constructor(private key: Buffer) {}

  static fromEnvironment(keyFile: string, envValue = process.env.PLANNING_SECRET_KEY) {
    if (envValue) {
      const key = Buffer.from(envValue, 'base64')
      if (key.length !== 32) throw new Error('PLANNING_SECRET_KEY должен быть 32 байтами в base64')
      return new SecretBox(key)
    }
    if (existsSync(keyFile)) return new SecretBox(Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64'))
    mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 })
    const key = randomBytes(32)
    writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 })
    chmodSync(keyFile, 0o600)
    return new SecretBox(key)
  }

  static ephemeral() { return new SecretBox(randomBytes(32)) }

  seal(value: unknown) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':')
  }

  open<T>(sealed: string): T {
    const [version, iv, tag, data] = sealed.split(':')
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Неизвестный формат секрета')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')) as T
  }
}
