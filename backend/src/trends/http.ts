/** Bound response sizes for feeds and model outputs, including chunked responses. */
export async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) throw new Error('Ответ превышает допустимый размер')
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
