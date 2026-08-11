import { createDiv, createEl } from '../runtime/web/obsidianDomCompat'

import type { ModalSpec } from './webShellTypes'

export function renderLightweightModalView(
  rootEl: HTMLElement,
  spec: ModalSpec,
): () => void {
  rootEl.empty()
  const pageEl = createDiv(rootEl, 'yolo-web-auth-page')
  const cardEl = createDiv(pageEl, 'modal mod-settings')
  const contentEl = createDiv(cardEl, 'modal-content')

  createDiv(contentEl, 'yolo-web-auth-title', (titleEl) =>
    titleEl.setText(spec.title),
  )
  createDiv(contentEl, 'yolo-web-auth-copy', (copyEl) => {
    createDiv(copyEl, 'setting-item-description', (descEl) =>
      descEl.setText(spec.description),
    )
  })

  if (spec.onSubmit) {
    let currentValue = ''
    const formEl = createEl(contentEl, 'form', {
      cls: 'yolo-web-auth-form',
    }) as HTMLFormElement

    const inputEl = createEl(formEl, 'input', {
      cls: 'yolo-web-auth-input',
      attr: {
        type: spec.password ? 'password' : 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: '请粘贴访问令牌',
      },
    }) as HTMLInputElement

    const errorEl = createDiv(formEl, 'yolo-web-auth-error')
    if (spec.error) {
      errorEl.setText(spec.error)
    }

    const submitBtn = createEl(formEl, 'button', {
      cls: 'mod-cta yolo-web-auth-submit',
      text: spec.submitLabel ?? '提交',
      attr: { type: 'submit' },
    }) as HTMLButtonElement

    const syncSubmitState = () => {
      currentValue = inputEl.value.trim()
      submitBtn.disabled = currentValue.length === 0 || Boolean(spec.loading)
    }

    inputEl.addEventListener('input', syncSubmitState)
    syncSubmitState()
    window.setTimeout(() => inputEl.focus(), 0)

    formEl.addEventListener('submit', async (event) => {
      event.preventDefault()
      if (!currentValue || spec.loading) return
      await spec.onSubmit?.(currentValue)
    })
  }

  return () => pageEl.remove()
}
