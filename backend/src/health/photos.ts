import sharp from 'sharp'
import { HealthError } from './schema.js'

export async function prepareMealPhoto(dataUrl: string): Promise<Buffer> {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!match) throw new HealthError('Выберите фотографию JPEG, PNG или WebP')
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > 6 * 1024 * 1024) throw new HealthError('Размер фото должен быть не больше 6 МиБ')
  try {
    const input = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' })
    const metadata = await input.metadata()
    if (metadata.format !== match[1] || (metadata.pages ?? 1) > 1) throw new Error('Invalid format')
    return await input.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer()
  } catch { throw new HealthError('Не удалось прочитать фото. Нужен неподвижный JPEG, PNG или WebP до 40 Мп.') }
}
