import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const maxBytes = 250 * 1024 * 1024
export const videoExtension = name => name.match(/\.(mp4|webm)$/i)?.[0].toLowerCase()
const fallback = ' Если ссылка открывается только после входа, скачайте видео из облака и загрузите его вручную.'

export function normalizeLink(value) {
  let url
  try { url = new URL(value.trim()) } catch { throw new Error('Введите действительную ссылку Яндекс Диска.') }
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !['disk.yandex.ru', 'yadi.sk'].includes(url.hostname) || !/^\/i\/[\w-]+\/?$/.test(url.pathname)) {
    throw new Error('Нужна публичная ссылка Яндекс Диска на отдельный видеофайл.' + fallback)
  }
  return 'https://disk.yandex.ru' + url.pathname.replace(/\/$/, '')
}

function downloadHost(url) {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    (url.hostname === 'downloader.disk.yandex.ru' ||
      /^(?:[a-z0-9-]+\.)*(?:storage\.yandex\.net|disk\.yandex\.net)$/.test(url.hostname))
}

async function request(url, signal) {
  let response
  try {
    response = await fetch(url, { signal, redirect: 'manual' })
  } catch {
    throw new Error('Не удалось связаться с Яндекс Диском. Проверьте интернет и попробуйте снова.')
  }
  if (response.ok || [301, 302, 303, 307, 308].includes(response.status)) return response
  await response.body?.cancel()
  if (response.status === 429) {
    throw new Error('Яндекс Диск временно ограничил скачивание. Попробуйте позже или загрузите файл вручную.')
  }
  throw new Error('Яндекс Диск не разрешил скачать файл по этой ссылке.' + fallback)
}

async function publicResource(link, endpoint, signal) {
  const url = new URL('https://cloud-api.yandex.net/v1/disk/public/resources' + endpoint)
  url.searchParams.set('public_key', link)
  const response = await request(url, signal)
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('Не удалось открыть публичную ссылку.' + fallback)
  }
  return response.json()
}

export async function downloadVideo(link, path, setName) {
  const signal = AbortSignal.timeout(180_000)
  const info = await publicResource(link, '', signal)
  if (info.type !== 'file' || typeof info.name !== 'string' || !videoExtension(info.name)) {
    throw new Error('По ссылке должен быть отдельный файл MP4 или WebM.')
  }
  await setName(info.name)
  if (info.size > maxBytes || info.size === 0) throw new Error('Выберите непустой файл размером до 250 МБ.')
  const download = await publicResource(link, '/download', signal)
  let url = new URL(download.href)
  let response
  for (let hops = 0; hops < 5; hops++) {
    if (!downloadHost(url)) throw new Error('Яндекс Диск вернул неподдерживаемый адрес скачивания.' + fallback)
    response = await request(url, signal)
    if (response.ok) break
    await response.body?.cancel()
    url = new URL(response.headers.get('location'), url)
  }
  if (response?.status !== 200 || !response.body ||
      response.headers.get('content-type')?.startsWith('text/html')) {
    await response?.body?.cancel()
    throw new Error('По ссылке не удалось получить видео.' + fallback)
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel()
    throw new Error('Размер видео превышает 250 МБ.')
  }

  const hash = createHash('sha256')
  let bytes = 0
  let header = Buffer.alloc(0)
  const inspect = new Transform({
    transform(chunk, encoding, done) {
      bytes += chunk.length
      if (bytes > maxBytes) return done(new Error('Размер видео превышает 250 МБ.'))
      if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)])
      hash.update(chunk)
      done(null, chunk)
    }
  })
  try {
    await pipeline(Readable.fromWeb(response.body), inspect, createWriteStream(path, { flags: 'wx' }), { signal })
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) {
      throw new Error('Скачивание прервалось. Повторите попытку или загрузите видео вручную.')
    }
    throw error
  }
  const valid = videoExtension(info.name) === '.mp4'
    ? header.subarray(4, 8).toString() === 'ftyp'
    : header.subarray(0, 4).toString('hex') === '1a45dfa3'
  if (!valid) throw new Error('Содержимое файла не соответствует формату MP4 или WebM.')
  return hash.digest('hex')
}
