import { renderToStaticMarkup } from 'react-dom/server'

jest.mock('../../assets/provider-icons/anthropic.svg', () => ({
  __esModule: true,
  default: 'anthropic-logo',
}))
jest.mock('../../assets/provider-icons/openai.svg', () => ({
  __esModule: true,
  default: 'openai-logo',
}))
jest.mock('../../assets/provider-icons/hermes.svg', () => ({
  __esModule: true,
  default: 'hermes-logo',
}))
jest.mock('../../assets/provider-icons/pi.svg', () => ({
  __esModule: true,
  default: 'pi-logo',
}))

type CapturedRollerProps = {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  onValueClick: () => void
  onActivate: () => void
}

let mockRollerProps: CapturedRollerProps | null = null

jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? '',
  }),
}))

jest.mock('../common/RollerSelect', () => ({
  __esModule: true,
  default: (props: CapturedRollerProps) => {
    mockRollerProps = props
    return <button data-roller-value={props.value}>Roller</button>
  },
}))

import ViewToggle from './ViewToggle'

const BASE_PROPS = {
  activeView: 'chat' as const,
  onChangeView: () => {},
  activeRuntimeId: 'yolo' as const,
  onChangeRuntime: () => {},
  runtimeOptions: ['yolo', 'claude-code', 'codex', 'hermes', 'pi'] as const,
}

describe('ViewToggle single runtime picker', () => {
  beforeEach(() => {
    mockRollerProps = null
  })

  it('lists YOLO plus the available CLI runtimes in picker order', () => {
    const onChangeView = jest.fn()

    renderToStaticMarkup(
      <ViewToggle {...BASE_PROPS} onChangeView={onChangeView} />,
    )

    expect(mockRollerProps?.value).toBe('yolo')
    expect(mockRollerProps?.options.map((option) => option.value)).toEqual([
      'yolo',
      'claude-code',
      'codex',
      'hermes',
      'pi',
    ])
  })

  it('switches runtime directly from the picker menu', () => {
    const onChangeRuntime = jest.fn()
    const onChangeView = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        {...BASE_PROPS}
        onChangeRuntime={onChangeRuntime}
        onChangeView={onChangeView}
      />,
    )

    mockRollerProps?.onChange('claude-code')

    expect(onChangeRuntime).toHaveBeenCalledWith('claude-code')
    expect(onChangeView).toHaveBeenCalledWith('chat')
  })

  it('ignores unknown picker values', () => {
    const onChangeRuntime = jest.fn()
    const onChangeView = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        {...BASE_PROPS}
        onChangeRuntime={onChangeRuntime}
        onChangeView={onChangeView}
      />,
    )

    mockRollerProps?.onChange('unknown-runtime')

    expect(onChangeRuntime).not.toHaveBeenCalled()
    expect(onChangeView).not.toHaveBeenCalled()
  })

  it('does not re-commit the already active runtime', () => {
    const onChangeRuntime = jest.fn()
    const onChangeView = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        {...BASE_PROPS}
        onChangeRuntime={onChangeRuntime}
        onChangeView={onChangeView}
      />,
    )

    mockRollerProps?.onChange('yolo')

    expect(onChangeRuntime).not.toHaveBeenCalled()
    expect(onChangeView).not.toHaveBeenCalled()
  })

  it('quick-toggles between exactly two choices on trigger click', () => {
    const onChangeRuntime = jest.fn()
    const onChangeView = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        {...BASE_PROPS}
        activeRuntimeId="yolo"
        runtimeOptions={['yolo', 'codex']}
        onChangeRuntime={onChangeRuntime}
        onChangeView={onChangeView}
      />,
    )

    mockRollerProps?.onValueClick()

    expect(onChangeRuntime).toHaveBeenCalledWith('codex')
    expect(onChangeView).toHaveBeenCalledWith('chat')
  })

  it('opens the menu instead of toggling when more than two choices exist', () => {
    const onChangeRuntime = jest.fn()
    const onChangeView = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        {...BASE_PROPS}
        onChangeRuntime={onChangeRuntime}
        onChangeView={onChangeView}
      />,
    )

    mockRollerProps?.onValueClick()

    expect(onChangeRuntime).not.toHaveBeenCalled()
    expect(onChangeView).not.toHaveBeenCalled()
  })

  it('only enters Agent without changing runtime when activated from composer', () => {
    const onChangeRuntime = jest.fn()
    const onChangeView = jest.fn()

    renderToStaticMarkup(
      <ViewToggle
        {...BASE_PROPS}
        activeView="composer"
        onChangeRuntime={onChangeRuntime}
        onChangeView={onChangeView}
      />,
    )

    mockRollerProps?.onActivate()

    expect(onChangeRuntime).not.toHaveBeenCalled()
    expect(onChangeView).toHaveBeenCalledWith('chat')
  })

  it('renders a fixed YOLO entry when no CLI runtime is available', () => {
    const html = renderToStaticMarkup(
      <ViewToggle
        {...BASE_PROPS}
        runtimeOptions={['yolo']}
        showComposer={false}
      />,
    )

    expect(mockRollerProps).toBeNull()
    expect(html).toContain('>YOLO<')
    expect(html).not.toContain('data-roller-value')
  })
})
