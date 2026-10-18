import { TelegramBot, TelegramRouter, type SendOptions } from './bot.js'

/** Where the bot token is kept; the planning store encrypts it. */
export interface TokenStore { get(): string | null; set(token: string | null): void }
export type BotStatus = { configured: boolean; managed: boolean; running: boolean; botUsername: string | null; error: string | null }

/**
 * One bot for the whole application. Modules add commands to `router` before `start()`.
 * A managed bot (TELEGRAM_BOT_TOKEN on the server) starts with the service and cannot be replaced from the website.
 */
export class TelegramService {
  readonly router = new TelegramRouter()
  private bot: TelegramBot | null = null
  private controller: AbortController | null = null
  private username: string | null = null
  private error: string | null = null
  private running = false
  private retry: NodeJS.Timeout | null = null

  constructor(private tokens: TokenStore, private fetcher: typeof fetch = fetch, private baseUrl?: string, readonly managed = false) {}

  status(): BotStatus { return { configured: Boolean(this.tokens.get()), managed: this.managed, running: this.running, botUsername: this.username, error: this.error } }
  get botUsername() { return this.username }
  get active() { return this.running && this.bot !== null }

  async start() {
    const token = this.tokens.get()
    if (!token || this.running) return
    try { await this.launch(new TelegramBot(token, this.fetcher, this.baseUrl)) } catch (error) {
      const rejected = error instanceof Error && /401|Unauthorized|Not Found/i.test(error.message)
      this.error = rejected ? `Telegram не принял токен бота${this.managed ? ' из TELEGRAM_BOT_TOKEN' : ''}` : `Бот не запустился: ${error instanceof Error ? error.message : 'ошибка сети'}. Повторю через 30 секунд.`
      // No network at startup should not leave the project bot down until the next restart.
      if (!rejected) { this.retry = setTimeout(() => { this.retry = null; void this.start() }, 30000); this.retry.unref() }
    }
  }

  /** Validate the token with getMe before saving it, so a typo never replaces a working bot. */
  async configure(token: string) {
    if (this.managed) throw new Error('Бот проекта задан на сервере (TELEGRAM_BOT_TOKEN) — менять его через сайт не нужно')
    const bot = new TelegramBot(token, this.fetcher, this.baseUrl)
    await bot.getMe().catch(() => { throw new Error('Telegram не принял токен. Скопируйте его из @BotFather целиком.') })
    this.tokens.set(token)
    await this.stop()
    await this.launch(bot)
    return this.status()
  }

  private async launch(bot: TelegramBot) {
    const me = await bot.getMe()
    this.username = me.username
    this.bot = bot
    this.error = null
    await bot.setCommands(this.router.commandList()).catch(() => undefined)
    const controller = new AbortController()
    this.controller = controller
    this.running = true
    void bot.poll((update) => this.router.dispatch(bot, update), controller.signal, (error) => { this.error = error?.message ?? null })
      .finally(() => { if (this.controller === controller) this.running = false })
  }

  async stop() {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.controller?.abort()
    this.controller = null
    this.bot = null
    this.running = false
  }

  async remove() {
    if (this.managed) throw new Error('Бот проекта задан на сервере (TELEGRAM_BOT_TOKEN): его нельзя отключить через сайт')
    await this.stop()
    this.tokens.set(null)
    this.username = null
    this.error = null
  }

  async send(chatId: string, text: string, options?: SendOptions) {
    if (!this.bot) throw new Error('Telegram-бот не запущен')
    return this.bot.send(chatId, text, options)
  }
}
