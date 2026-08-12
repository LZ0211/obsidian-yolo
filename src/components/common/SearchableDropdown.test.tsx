jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string, fallback?: string) =>
      ({
        'common.loading': '加载中',
        'common.off': '已禁用',
        'common.search': '搜索...',
      })[key] ??
      fallback ??
      key,
  }),
}))

jest.mock('./ObsidianSetting', () => ({
  useObsidianSetting: () => ({ setting: null }),
}))

import { renderToStaticMarkup } from 'react-dom/server'

import { SearchableDropdown } from './SearchableDropdown'

describe('SearchableDropdown', () => {
  it('uses translated disabled and loading placeholders', () => {
    const disabled = renderToStaticMarkup(
      <SearchableDropdown
        value=""
        options={[]}
        onChange={() => undefined}
        disabled
      />,
    )
    const loading = renderToStaticMarkup(
      <SearchableDropdown
        value=""
        options={[]}
        onChange={() => undefined}
        loading
      />,
    )

    expect(disabled).toContain('placeholder="已禁用"')
    expect(loading).toContain('placeholder="加载中"')
  })

  it('uses the translated default search placeholder', () => {
    const markup = renderToStaticMarkup(
      <SearchableDropdown value="" options={[]} onChange={() => undefined} />,
    )

    expect(markup).toContain('placeholder="搜索..."')
  })

  it('provides a programmatic label for the search input', () => {
    const markup = renderToStaticMarkup(
      <SearchableDropdown
        value=""
        options={[]}
        onChange={() => undefined}
        ariaLabel="Choose a model"
      />,
    )

    expect(markup).toContain('aria-label="Choose a model"')
  })
})
