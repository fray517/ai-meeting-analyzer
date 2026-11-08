const file = document.querySelector('#file')
const choose = document.querySelector('#choose')
const drop = document.querySelector('#drop')
const status = document.querySelector('#status')
const cloudForm = document.querySelector('#cloud-form')
const cloudLink = document.querySelector('#cloud-link')
const cloudSubmit = document.querySelector('#cloud-submit')
const openExisting = document.querySelector('#open-existing')
const empty = document.querySelector('#empty')
const meetings = document.querySelector('#meetings')
const date = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' })
const labels = {
  processing: 'Обрабатывается',
  downloading: 'Получение файла',
  transcribing: 'Распознавание речи',
  analyzing: 'AI-анализ',
  ready: 'Готово',
  error: 'Ошибка'
}
let uploading = false
let busy = false
let snapshot = ''
let selected

function element(tag, value, className) {
  const node = document.createElement(tag)
  if (value !== undefined) node.textContent = value
  if (className) node.className = className
  return node
}

function show(message, error = false) {
  status.hidden = !message
  status.textContent = message
  status.classList.toggle('error', error)
}

function updateButton() {
  choose.disabled = busy || uploading
  cloudSubmit.disabled = choose.disabled
}

function render(rows) {
  empty.hidden = rows.length > 0
  empty.textContent = 'Здесь появятся загруженные встречи.'
  const signature = JSON.stringify(rows)
  if (signature === snapshot) return
  snapshot = signature
  const opened = new Map([...meetings.children].map(row => [
    row.dataset.id, { row: row.open, transcript: row.querySelector('.transcript')?.open }
  ]))
  meetings.replaceChildren(...rows.map(row => {
    const card = element('details', undefined, 'meeting')
    card.dataset.id = row.id
    card.open = opened.get(row.id)?.row ?? row.id === selected
    const heading = element('summary')
    const meta = element('span', undefined, 'meta')
    const source = row.source === 'cloud' ? 'Из облака' : 'Загружено вручную'
    const time = element('time', date.format(new Date(row.addedAt)) + ' · ' + source)
    time.dateTime = row.addedAt
    meta.append(element('strong', row.name), time)
    heading.append(meta, element('span', labels[row.status], 'badge ' + row.status))
    card.append(heading)

    const result = element('div', undefined, 'result')
    if (row.status === 'ready') {
      result.append(element('h3', 'Краткое содержание'), element('p', row.notes.overview))
      for (const [key, label, fallback] of [
        ['decisions', 'Решения', 'Решений нет.'],
        ['tasks', 'Задачи', 'Задач нет.'],
        ['questions', 'Открытые вопросы', 'Открытых вопросов нет.']
      ]) {
        result.append(element('h3', label))
        if (row.notes[key].length) {
          const list = element('ul')
          list.append(...row.notes[key].map(item => element('li', item)))
          result.append(list)
        } else {
          result.append(element('p', fallback))
        }
      }
      const transcript = element('details', undefined, 'transcript')
      transcript.open = Boolean(opened.get(row.id)?.transcript)
      transcript.append(element('summary', 'Расшифровка'), element('p', row.transcript))
      result.append(transcript)
    } else {
      result.append(element('p', row.error || 'Обработка записи идёт автоматически.'))
    }
    card.append(result)
    return card
  }))
}

async function poll() {
  try {
    if (!uploading) {
      const response = await fetch('/api/meetings')
      if (!response.ok) throw new Error()
      const state = await response.json()
      if (!uploading) {
        busy = state.busy
        updateButton()
        render(state.meetings)
        const current = state.meetings.find(row => row.id === selected)
        const duplicate = state.duplicates?.[selected]
        if (duplicate) {
          show('Эта запись уже обработана.')
          openExisting.dataset.id = duplicate
          openExisting.hidden = false
          selected = undefined
        } else if (current && ['ready', 'error'].includes(current.status)) {
          show(current.status === 'ready' ? 'Готово. Конспект и расшифровка доступны в истории.' : current.error, current.status === 'error')
          selected = undefined
        } else if (current) {
          if (status.textContent !== labels[current.status]) show(labels[current.status])
        } else if (status.dataset.offline) {
          show('')
        }
        delete status.dataset.offline
      }
    }
  } catch {
    if (!uploading) {
      status.dataset.offline = '1'
      show('Связь с приложением потеряна. Проверьте, что локальный сервер запущен.', true)
    }
  } finally {
    setTimeout(poll, 1200)
  }
}

async function upload(video) {
  if (!video || uploading || busy) return
  if (!/\.(mp4|webm)$/i.test(video.name)) return show('Выберите файл MP4 или WebM.', true)
  if (!video.size || video.size > 250 * 1024 * 1024) {
    return show('Выберите непустой файл размером до 250 МБ.', true)
  }
  await submit('/api/meetings', video, { 'X-File-Name': encodeURIComponent(video.name) }, 'Загружаем видео…')
}

async function submit(url, body, headers, message) {
  if (uploading || busy) return
  openExisting.hidden = true
  uploading = true
  updateButton()
  show(message)
  try {
    const response = await fetch(url, { method: 'POST', headers, body })
    const row = await response.json()
    if (!response.ok) {
      show(row.error, true)
      return
    }
    selected = row.id
    busy = true
    show(labels[row.status])
  } catch {
    show('Не удалось загрузить видео. Проверьте связь с приложением и попробуйте снова.', true)
  } finally {
    uploading = false
    updateButton()
  }
}

cloudForm.addEventListener('submit', event => {
  event.preventDefault()
  submit('/api/meetings/cloud', cloudLink.value.trim(), {}, 'Проверяем ссылку…')
})
openExisting.addEventListener('click', () => {
  const card = [...meetings.children].find(row => row.dataset.id === openExisting.dataset.id)
  if (card) {
    card.open = true
    card.querySelector('summary').focus()
  }
})
choose.addEventListener('click', () => file.click())
file.addEventListener('change', () => {
  const video = file.files[0]
  file.value = ''
  upload(video)
})
drop.addEventListener('dragover', event => {
  event.preventDefault()
  drop.classList.toggle('dragging', !choose.disabled)
})
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'))
drop.addEventListener('drop', event => {
  event.preventDefault()
  drop.classList.remove('dragging')
  upload(event.dataTransfer.files[0])
})
poll()
