import { useEffect, useState } from 'react'

import { useObsidianSetting } from './ObsidianSetting'

/**
 * Appends a dedicated div into the enclosing ObsidianSetting's `controlEl`
 * and returns it as a portal target. Obsidian's `Setting` components
 * (addText/addButton/...) append imperatively into `controlEl`, bypassing
 * React's own child ordering — plain JSX children of `ObsidianSetting` render
 * into its outer wrapper div instead, landing outside the name/control row.
 * Portaling into this container keeps custom controls inside that same row,
 * in the effect-registration order relative to sibling addText/addButton calls.
 */
export function useObsidianSettingPortalContainer(): HTMLElement | null {
  const { setting } = useObsidianSetting()
  const [container, setContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!setting) {
      setContainer(null)
      return
    }
    const el = setting.controlEl.createDiv({
      cls: 'yolo-setting-control-portal',
    })
    setContainer(el)
    return () => {
      el.remove()
      setContainer(null)
    }
  }, [setting])

  return container
}
