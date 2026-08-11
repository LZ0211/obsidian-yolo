jest.mock('react', () => {
  const actual = jest.requireActual('react')
  return {
    ...actual,
    useLayoutEffect: actual.useEffect,
  }
})

import { renderToStaticMarkup } from 'react-dom/server'

import { WebCsvPreview } from './WebCsvPreview'

describe('WebCsvPreview', () => {
  it('renders headers and rows', () => {
    const csv = 'Name,Age,City\nAlice,30,NYC\nBob,25,LA'
    const html = renderToStaticMarkup(<WebCsvPreview content={csv} />)
    expect(html).toContain('Name')
    expect(html).toContain('Age')
    expect(html).toContain('City')
    expect(html).toContain('Alice')
    expect(html).toContain('30')
    expect(html).toContain('NYC')
    expect(html).toContain('Bob')
    expect(html).toContain('25')
    expect(html).toContain('LA')
    expect(html).toContain('<thead>')
    expect(html).toContain('<tbody>')
  })

  it('renders empty CSV message for empty string', () => {
    const html = renderToStaticMarkup(<WebCsvPreview content="" />)
    expect(html).toContain('Empty CSV file.')
  })

  it('renders empty CSV message for whitespace-only content', () => {
    const html = renderToStaticMarkup(<WebCsvPreview content="   " />)
    expect(html).toContain('Empty CSV file.')
  })

  it('shows row limit warning when rows exceed maxRows', () => {
    const headers = 'A,B,C'
    const rows = Array.from({ length: 201 }, (_, i) => `${i},${i + 1},${i + 2}`)
    const csv = [headers, ...rows].join('\n')
    const html = renderToStaticMarkup(
      <WebCsvPreview content={csv} maxRows={200} />,
    )
    expect(html).toContain('Showing first 200 rows of 201')
    const tbodyMatch = html.match(/<tr>/g)
    // 1 header row + 200 body rows
    expect(tbodyMatch?.length).toBe(201)
  })

  it('does not show warning when rows are under limit', () => {
    const csv = 'A,B,C\n1,2,3\n4,5,6'
    const html = renderToStaticMarkup(<WebCsvPreview content={csv} />)
    expect(html).not.toContain('Showing first')
  })

  it('renders table even for single-column CSV', () => {
    const csv = 'Value\n1\n2\n3'
    const html = renderToStaticMarkup(<WebCsvPreview content={csv} />)
    expect(html).toContain('Value')
    expect(html).toContain('<thead>')
    expect(html).toContain('<tbody>')
  })
})
