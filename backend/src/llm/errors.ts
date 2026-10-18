/** Only curated messages may cross the provider boundary. Never forward raw error bodies. */
export class ModelError extends Error {
  constructor(readonly code: 'context_limit' | 'rate_limit' | 'credentials' | 'unavailable' | 'invalid_response' | 'timeout', message: string) { super(message) }
}
export function classifyProviderError(value: unknown): ModelError {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  if (/context|maximum.*token|too many tokens|input.*long|prompt.*long/i.test(raw)) return new ModelError('context_limit', 'История или результаты инструментов превысили контекст модели. Начните новый диалог или сузьте запрос.')
  if (/rate.?limit|429|quota/i.test(raw)) return new ModelError('rate_limit', 'Провайдер временно ограничил запросы. Попробуйте чуть позже.')
  return new ModelError('unavailable', 'Модель на Runpod не завершила запрос. Попробуйте ещё раз; автоматический повтор не выполняется.')
}
