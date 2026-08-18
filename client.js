window.__ModuleLoader__.load({
  id: 'dsh-eyes',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useRef } = React
    const h = React.createElement

    const BACKENDS = [
      { id: 'grok-cli', label: '本机 grok（已登录即可）' },
      { id: 'claude-cli', label: '本机 Claude Code' },
      { id: 'codex-cli', label: '本机 Codex' },
      { id: 'xai', label: 'xAI HTTP' },
      { id: 'openai', label: 'OpenAI HTTP' },
      { id: 'qwen', label: '通义 HTTP' },
      { id: 'custom', label: '自定义 HTTP' },
    ]

    const ACCEPT = '.pdf,.mp4,.webm,.mov,.mkv,.avi,.m4v,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp,.gif'
    const EYES_EXT = /\.(pdf|mp4|webm|mov|mkv|avi|m4v|docx|xlsx|pptx)$/i
    const IMAGE_TYPE = /^image\/(png|jpeg|webp|gif)$/

    const CSS = `
.dsheyes-root { display:flex; flex-direction:column; gap:14px; font-size:13px; color:var(--dsw-alias-label-primary); max-width:560px; padding:4px 2px 24px; }
.dsheyes-lead { margin:0; color:var(--dsw-alias-label-secondary); line-height:1.5; }
.dsheyes-field { display:flex; flex-direction:column; gap:6px; }
.dsheyes-label { font-weight:600; }
.dsheyes-hint { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.45; }
.dsheyes-input, .dsheyes-select { height:34px; padding:0 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
.dsheyes-row { display:flex; gap:12px; }
.dsheyes-row > * { flex:1; }
.dsheyes-actions { display:flex; gap:8px; align-items:center; }
.dsheyes-btn { height:34px; padding:0 14px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); cursor:pointer; }
.dsheyes-btn-primary { background:var(--dsw-alias-brand-primary); border-color:transparent; color:#fff; }
.dsheyes-btn:disabled { opacity:0.55; cursor:default; }
.dsheyes-ok { color:var(--dsw-alias-brand-primary); }
.dsheyes-err { color:#d14343; }
.dsheyes-pick { height:28px; padding:0 10px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-primary); cursor:pointer; font-size:12px; }
.dsheyes-pick:disabled { opacity:0.55; cursor:default; }
.dsheyes-toast { position:fixed; right:16px; bottom:84px; z-index:40; max-width:360px; padding:8px 12px; border-radius:8px; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); font-size:12px; }
`

    function isCli(backend) {
      return backend === 'grok-cli' || backend === 'claude-cli' || backend === 'codex-cli'
    }

    function isEyesFile(file) {
      if (!file) return false
      if (IMAGE_TYPE.test(file.type)) return false
      if (EYES_EXT.test(file.name || '')) return true
      return /pdf|video|officedocument|presentationml|spreadsheetml|ms-excel|ms-powerpoint/i.test(file.type || '')
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const s = String(reader.result || '')
          const i = s.indexOf(',')
          resolve(i >= 0 ? s.slice(i + 1) : s)
        }
        reader.onerror = () => reject(reader.error || new Error('读文件失败'))
        reader.readAsDataURL(file)
      })
    }

    function insertComposerText(chunk) {
      const el = document.querySelector('[data-composer-card] textarea')
      if (!el || el.disabled || el.readOnly) return false
      el.focus()
      const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? el.value.length
      const prefix = el.value.slice(0, start)
      const suffix = el.value.slice(end)
      const glue = prefix && !prefix.endsWith('\n') ? '\n' : ''
      const next = prefix + glue + chunk + (suffix.startsWith('\n') || !suffix ? '' : '\n') + suffix
      if (desc && desc.set) desc.set.call(el, next)
      else el.value = next
      const caret = (prefix + glue + chunk).length
      try { el.setSelectionRange(caret, caret) } catch { /* ignore */ }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }

    function toast(text) {
      let node = document.getElementById('dsheyes-toast')
      if (!node) {
        node = document.createElement('div')
        node.id = 'dsheyes-toast'
        node.className = 'dsheyes-toast'
        document.body.appendChild(node)
      }
      node.textContent = text
      clearTimeout(toast._t)
      toast._t = setTimeout(() => { if (node.parentNode) node.remove() }, 4000)
    }

    async function uploadFiles(files) {
      const list = Array.from(files || []).filter(Boolean)
      if (!list.length) return
      toast(list.length === 1 ? `正在收下 ${list[0].name}` : `正在收下 ${list.length} 个文件`)
      const paths = []
      for (const file of list) {
        const dataBase64 = await fileToBase64(file)
        const res = await fetch('/dsh-eyes/intake', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: file.name, dataBase64 }),
        })
        const data = await res.json()
        if (!data || !data.ok) throw new Error((data && data.error) || '上传失败')
        paths.push(data.path)
      }
      const note = paths.length === 1
        ? `请用 see_file 看这个文件：${paths[0]}`
        : `请用 see_file 看这些文件：\n${paths.map((p) => `- ${p}`).join('\n')}`
      if (!insertComposerText(note)) {
        toast(`已保存：${paths.join('，')}。把路径贴进发送框即可。`)
        return
      }
      toast('文件已放进发送框，发送后眼睛会去看。')
    }

    function EyesUpload() {
      const ref = useRef(null)
      const [busy, setBusy] = useState(false)
      const pick = (event) => {
        event.preventDefault()
        if (!busy) ref.current && ref.current.click()
      }
      const onChange = (event) => {
        const files = Array.from(event.target.files || [])
        event.target.value = ''
        if (!files.length) return
        setBusy(true)
        uploadFiles(files).catch((error) => {
          toast(error.message || String(error))
        }).finally(() => setBusy(false))
      }
      return h('div', { className: 'dsheyes-upload' },
        h('input', {
          ref,
          type: 'file',
          multiple: true,
          accept: ACCEPT,
          hidden: true,
          onChange,
        }),
        h('button', {
          type: 'button',
          className: 'dsheyes-pick',
          disabled: busy,
          title: '上传 PDF、视频、Word / Excel / PPT，给眼睛看',
          onMouseDown: (e) => e.preventDefault(),
          onClick: pick,
        }, busy ? '收下…' : '文件'),
      )
    }

    function installDropPaste() {
      if (window.__dsheyesIntake) return
      window.__dsheyesIntake = true
      let busy = false
      const take = (event) => {
        const files = event.type === 'paste'
          ? Array.from(event.clipboardData ? event.clipboardData.files : [])
          : Array.from(event.dataTransfer ? event.dataTransfer.files : [])
        const eyes = files.filter(isEyesFile)
        if (!eyes.length || busy) return
        event.preventDefault()
        event.stopImmediatePropagation()
        busy = true
        uploadFiles(eyes).catch((error) => {
          toast(error.message || String(error))
        }).finally(() => { busy = false })
      }
      window.addEventListener('drop', take, true)
      window.addEventListener('paste', take, true)
    }

    function apply(ctx) {
      if (!document.getElementById('dsheyes-css')) {
        const style = document.createElement('style')
        style.id = 'dsheyes-css'
        style.textContent = CSS
        document.head.appendChild(style)
      }
      installDropPaste()

      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('conversation.input.left', () => slots.register(
        { name: 'conversation.input.left', id: 'dsh-eyes-file', order: 20 },
        EyesUpload,
      ))
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'dsh-eyes', order: 16, label: () => '看图' },
        function EyesSettings() {
          const [draft, setDraft] = useState(null)
          const [status, setStatus] = useState({ kind: 'idle', text: '' })
          const [busy, setBusy] = useState(false)

          const load = () => {
            setStatus({ kind: 'idle', text: '' })
            fetch('/dsh-eyes/config').then((r) => r.json()).then((data) => {
              if (!data || !data.ok) throw new Error((data && data.error) || '读配置失败')
              setDraft({
                backend: data.config.backend || 'grok-cli',
                cliPath: data.config.cliPath || '',
                cliModel: data.config.cliModel || '',
                baseURL: data.config.baseURL || '',
                model: data.config.model || '',
                apiKeyEnv: data.config.apiKeyEnv || '',
                timeoutMs: String(data.config.timeoutMs || 120000),
                maxImageBytes: String(data.config.maxImageBytes || 10485760),
                maxPages: String(data.config.maxPages || 8),
                maxFrames: String(data.config.maxFrames || 8),
              })
            }).catch((error) => {
              setStatus({ kind: 'err', text: error.message || String(error) })
              if (!draft) {
                setDraft({
                  backend: 'grok-cli', cliPath: '', cliModel: '',
                  baseURL: '', model: '', apiKeyEnv: '',
                  timeoutMs: '120000', maxImageBytes: '10485760',
                  maxPages: '8', maxFrames: '8',
                })
              }
            })
          }

          useEffect(() => { load() }, [])

          const setField = (key) => (event) => {
            setDraft({ ...draft, [key]: event.target.value })
          }

          const save = () => {
            if (!draft) return
            setBusy(true)
            setStatus({ kind: 'idle', text: '' })
            fetch('/dsh-eyes/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                backend: draft.backend,
                cliPath: draft.cliPath,
                cliModel: draft.cliModel,
                baseURL: draft.baseURL,
                model: draft.model,
                apiKeyEnv: draft.apiKeyEnv,
                timeoutMs: Number(draft.timeoutMs),
                maxImageBytes: Number(draft.maxImageBytes),
                maxPages: Number(draft.maxPages),
                maxFrames: Number(draft.maxFrames),
              }),
            }).then((r) => r.json()).then((data) => {
              if (!data || !data.ok) throw new Error((data && data.error) || '保存失败')
              setStatus({ kind: 'ok', text: '已保存，下一张图就会用新后端。钥匙不要写在这里。' })
            }).catch((error) => {
              setStatus({ kind: 'err', text: error.message || String(error) })
            }).finally(() => setBusy(false))
          }

          if (!draft) {
            return h('div', { className: 'dsheyes-root' }, status.kind === 'err' ? status.text : '加载中…')
          }

          const cli = isCli(draft.backend)
          return h('div', { className: 'dsheyes-root' },
            h('p', { className: 'dsheyes-lead' },
              '选谁来看。发送框左边有「文件」按钮，PDF、视频、Office 选上去就行。图片还是直接粘贴。',
            ),
            h('div', { className: 'dsheyes-field' },
              h('label', { className: 'dsheyes-label' }, '看图后端'),
              h('select', { className: 'dsheyes-select', value: draft.backend, onChange: setField('backend') },
                BACKENDS.map((item) => h('option', { value: item.id, key: item.id }, item.label)),
              ),
              h('div', { className: 'dsheyes-hint' },
                cli
                  ? '本机命令，用你已经登录的 grok / claude / codex，不会去翻登录文件。'
                  : '走网上的看图接口。钥匙只放环境变量或 ~/.dsh/.credentials.yaml，这里只填变量名。',
              ),
            ),
            cli
              ? [
                  h('div', { className: 'dsheyes-field', key: 'cliPath' },
                    h('label', { className: 'dsheyes-label' }, '命令路径（可选）'),
                    h('input', { className: 'dsheyes-input', value: draft.cliPath, onChange: setField('cliPath'), placeholder: '空着就用 PATH 里的 grok / claude / codex' }),
                  ),
                  h('div', { className: 'dsheyes-field', key: 'cliModel' },
                    h('label', { className: 'dsheyes-label' }, 'CLI 模型（可选）'),
                    h('input', { className: 'dsheyes-input', value: draft.cliModel, onChange: setField('cliModel'), placeholder: '空着就用该命令的默认模型' }),
                  ),
                ]
              : [
                  h('div', { className: 'dsheyes-field', key: 'baseURL' },
                    h('label', { className: 'dsheyes-label' }, '接口地址'),
                    h('input', { className: 'dsheyes-input', value: draft.baseURL, onChange: setField('baseURL'), placeholder: 'https://…  自定义必填，预设可空' }),
                  ),
                  h('div', { className: 'dsheyes-field', key: 'model' },
                    h('label', { className: 'dsheyes-label' }, '模型名'),
                    h('input', { className: 'dsheyes-input', value: draft.model, onChange: setField('model'), placeholder: '自定义必填，预设可空' }),
                  ),
                  h('div', { className: 'dsheyes-field', key: 'apiKeyEnv' },
                    h('label', { className: 'dsheyes-label' }, '钥匙的环境变量名'),
                    h('input', { className: 'dsheyes-input', value: draft.apiKeyEnv, onChange: setField('apiKeyEnv'), placeholder: '例如 XAI_API_KEY，不要把钥匙贴进来' }),
                  ),
                ],
            h('div', { className: 'dsheyes-row' },
              h('div', { className: 'dsheyes-field' },
                h('label', { className: 'dsheyes-label' }, '超时（毫秒）'),
                h('input', { className: 'dsheyes-input', value: draft.timeoutMs, onChange: setField('timeoutMs') }),
              ),
              h('div', { className: 'dsheyes-field' },
                h('label', { className: 'dsheyes-label' }, '图片上限（字节）'),
                h('input', { className: 'dsheyes-input', value: draft.maxImageBytes, onChange: setField('maxImageBytes') }),
              ),
            ),
            h('div', { className: 'dsheyes-row' },
              h('div', { className: 'dsheyes-field' },
                h('label', { className: 'dsheyes-label' }, 'PDF 最多看几页'),
                h('input', { className: 'dsheyes-input', value: draft.maxPages, onChange: setField('maxPages') }),
              ),
              h('div', { className: 'dsheyes-field' },
                h('label', { className: 'dsheyes-label' }, '视频最多抽几帧'),
                h('input', { className: 'dsheyes-input', value: draft.maxFrames, onChange: setField('maxFrames') }),
              ),
            ),
            h('div', { className: 'dsheyes-actions' },
              h('button', { className: 'dsheyes-btn dsheyes-btn-primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
              h('button', { className: 'dsheyes-btn', disabled: busy, onClick: load }, '重新读取'),
              status.text
                ? h('span', { className: status.kind === 'err' ? 'dsheyes-err' : 'dsheyes-ok' }, status.text)
                : null,
            ),
          )
        },
      ))
    }

    return { apply }
  },
})
