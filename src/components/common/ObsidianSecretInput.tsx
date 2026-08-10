import { Eye, EyeOff } from 'lucide-react'
import { TextComponent } from 'obsidian'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useLanguage } from '../../contexts/language-context'

import { useObsidianSetting } from './ObsidianSetting'
import { useObsidianSettingPortalContainer } from './useObsidianSettingPortal'

type ObsidianSecretInputProps = {
  value: string
  placeholder?: string
  onChange: (value: string) => void
  disabled?: boolean
}

export function ObsidianSecretInput({
  value,
  placeholder,
  onChange,
  disabled,
}: ObsidianSecretInputProps) {
  const { t } = useLanguage()
  const { setting } = useObsidianSetting()
  const [textComponent, setTextComponent] = useState<TextComponent | null>(null)
  const [visible, setVisible] = useState(false)
  const onChangeRef = useRef(onChange)

  useEffect(() => {
    if (!setting) return
    let newTextComponent: TextComponent | null = null
    setting.addText((component) => {
      newTextComponent = component
    })
    setTextComponent(newTextComponent)

    return () => {
      newTextComponent?.inputEl.remove()
    }
  }, [setting])

  // Registered after the addText effect above so the toggle button lands
  // after the input in controlEl's DOM order.
  const toggleContainer = useObsidianSettingPortalContainer()

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!textComponent) return
    textComponent.onChange((v) => onChangeRef.current(v))
  }, [textComponent])

  useEffect(() => {
    if (!textComponent) return
    textComponent.setValue(value)
    if (placeholder) textComponent.setPlaceholder(placeholder)
    textComponent.inputEl.type = visible ? 'text' : 'password'
    textComponent.setDisabled(!!disabled)
  }, [textComponent, value, placeholder, disabled, visible])

  if (!toggleContainer) return null

  return createPortal(
    <button
      type="button"
      className="clickable-icon"
      aria-label={
        visible
          ? t('settings.bots.form.hideToken', 'Hide token')
          : t('settings.bots.form.showToken', 'Show token')
      }
      onClick={() => setVisible((prev) => !prev)}
    >
      {visible ? <EyeOff size={16} /> : <Eye size={16} />}
    </button>,
    toggleContainer,
  )
}
