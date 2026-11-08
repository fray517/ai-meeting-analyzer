import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { processVideo } from './process-video.mjs'
import { downloadVideo, maxBytes, normalizeLink, videoExtension } from './cloud-video.mjs'

const data = fileURLToPath(new URL('./data/', import.meta.url))
const uploads = join(data, 'uploads')
const completedImports = new Map()
const meetings = new Map()
let busy = false


async function save(meeting) {
  const path = join(data, meeting.id + '.json')
  await writeFile(path + '.tmp', JSON.stringify(meeting, null, 2))
  await rename(path + '.tmp', path)
  meetings.set(meeting.id, meeting)
}

async function loadHistory() {
  await rm(uploads, { recursive: true, force: true })
  await mkdir(uploads, { recursive: true })
  for (const file of await readdir(data)) {
    if (!file.endsWith('.json')) continue
    const meeting = JSON.parse(await readFile(join(data, file), 'utf8'))
    if (['processing', 'downloading', 'transcribing', 'analyzing'].includes(meeting.status)) {
      await save({ ...meeting, status: 'error', error: 'Сервер перезапустился. Загрузите файл повторно.' })
    } else {
      meetings.set(meeting.id, meeting)
    }
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function publicMeeting({ linkId, fingerprint, ...meeting }) {
  return meeting
}

async function runJob(meeting, path, receiveCloud) {
  async function update(fields) {
    meeting = { ...meeting, ...fields }
    await save(meeting)
  }
  try {
    if (receiveCloud) {
      const fingerprint = await receiveCloud(name => update({ name }))
      const existing = [...meetings.values()].find(row => row.status === 'ready' && row.fingerprint === fingerprint)
      if (existing) {
        await rm(join(data, meeting.id + '.json'), { force: true })
        meetings.delete(meeting.id)
        completedImports.set(meeting.id, existing.id)
        if (completedImports.size > 50) completedImports.delete(completedImports.keys().next().value)
        return
      }
      await update({ fingerprint, status: 'transcribing' })
    }
    if (!process.env.OPENAI_API_KEY?.trim()) {
      throw new Error('Укажите OPENAI_API_KEY в файле .env, перезапустите приложение и добавьте видео повторно.')
    }
    const result = await processVideo(path, status => update({ status }))
    await update({ ...result, status: 'ready' })
  } catch (error) {
    const message = error.code || error instanceof SyntaxError || error instanceof TypeError
      ? 'Не удалось обработать запись. Проверьте настройки и повторите попытку.'
      : error.message
    const failed = { ...meeting, status: 'error', error: message }
    meetings.set(meeting.id, failed)
    await save(failed)
  } finally {
    try {
      await rm(path, { force: true })
    } finally {
      busy = false
    }
  }
}

async function accept(req, res, cloud) {
  const reject = (status, error) => json(res, status, { error })
  if (req.headers['sec-fetch-site'] === 'cross-site' ||
      (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) {
    return reject(403, 'Откройте приложение напрямую в браузере.')
  }
  if (busy) return reject(409, 'Дождитесь завершения текущей обработки.')
  const size = Number(req.headers['content-length'])
  if (!Number.isSafeInteger(size) || size < 1 || size > (cloud ? 4096 : maxBytes)) {
    return reject(400, cloud ? 'Введите ссылку на видео.' : 'Выберите непустой файл размером до 250 МБ.')
  }

  busy = true
  const id = randomUUID()
  let path = join(uploads, id)
  let started = false
  try {
    let name
    let receiveCloud
    let linkId
    if (cloud) {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      let link
      try {
        link = normalizeLink(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        return reject(400, error.message)
      }
      linkId = createHash('sha256').update(link).digest('hex')
      name = 'Видео с Яндекс Диска'
      receiveCloud = setName => downloadVideo(link, path, setName)
    } else {
      try {
        name = decodeURIComponent(req.headers['x-file-name'] || '').split(/[\\/]/).pop()
      } catch {
        return reject(400, 'Не удалось прочитать имя файла.')
      }
      const extension = videoExtension(name)
      if (!extension) return reject(400, 'Поддерживаются файлы MP4 и WebM.')
      path += extension
      await pipeline(req, createWriteStream(path, { flags: 'wx' }))
    }

    const meeting = {
      id, name, addedAt: new Date().toISOString(),
      source: cloud ? 'cloud' : 'manual',
      status: cloud ? 'downloading' : 'transcribing',
      ...(linkId && { linkId })
    }
    await save(meeting)
    json(res, 202, publicMeeting(meeting))
    started = true
    await runJob(meeting, path, receiveCloud)
  } finally {
    if (!started) {
      busy = false
      await rm(path, { force: true })
    }
  }
}
const assets = {
  '/': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript']
}
const port = Number(process.env.PORT || 3000)
let ready
const server = createServer(async (req, res) => {
  try {
    await ready
    if (req.headers.host !== '127.0.0.1:' + port) {
      return json(res, 403, { error: 'Откройте приложение по адресу http://127.0.0.1:' + port + '.' })
    }
    if (req.method === 'GET' && req.url === '/api/meetings') {
      return json(res, 200, { busy, meetings: [...meetings.values()].reverse().map(publicMeeting), duplicates: Object.fromEntries(completedImports) })
    }
    if (req.method === 'POST' && req.url === '/api/meetings') return await accept(req, res)
    if (req.method === 'POST' && req.url === '/api/meetings/cloud') return await accept(req, res, true)
    if (req.method === 'GET' && Object.hasOwn(assets, req.url)) {
      const [file, type] = assets[req.url]
      const content = await readFile(new URL('./public/' + file, import.meta.url))
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' })
      return res.end(content)
    }
    json(res, 404, { error: 'Страница не найдена.' })
  } catch (error) {
    console.error('Ошибка сервера:', error.code || error.name)
    if (!res.headersSent) json(res, 500, { error: 'Ошибка сервера. Повторите попытку.' })
  }
})
server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error('Порт ' + port + ' занят. Если приложение уже запущено, откройте http://127.0.0.1:' + port + '. Для другого порта задайте PORT в .env.')
  } else {
    console.error('Не удалось запустить сервер:', error.message)
  }
  process.exitCode = 1
})
server.listen(port, '127.0.0.1', () => {
  ready = loadHistory()
  ready.then(() => console.log('http://127.0.0.1:' + port)).catch(error => {
    console.error('Не удалось загрузить историю:', error.code || error.name)
    process.exitCode = 1
    server.close()
  })
})
