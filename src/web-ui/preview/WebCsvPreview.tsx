import * as Papa from 'papaparse'
import type { ReactElement } from 'react'

export type WebCsvPreviewProps = {
  content: string
  maxRows?: number
}

const DEFAULT_MAX_ROWS = 200

export function WebCsvPreview({
  content,
  maxRows = DEFAULT_MAX_ROWS,
}: WebCsvPreviewProps): ReactElement {
  if (!content.trim()) {
    return <div className="yolo-web-csv-preview-empty">Empty CSV file.</div>
  }

  const result = Papa.parse(content, { skipEmptyLines: true })
  const allRows = result.data as string[][]

  if (allRows.length === 0) {
    return (
      <div className="yolo-web-csv-preview-empty">Could not parse CSV.</div>
    )
  }

  const headers = allRows[0]
  const bodyRows = allRows.slice(1)
  const overLimit = bodyRows.length > maxRows
  const visibleRows = overLimit ? bodyRows.slice(0, maxRows) : bodyRows

  if (!headers || headers.length === 0 || headers.every((h) => !h)) {
    return (
      <div className="yolo-web-csv-preview-empty">Could not parse CSV.</div>
    )
  }

  return (
    <div className="yolo-web-csv-preview">
      {overLimit && (
        <div className="yolo-web-csv-preview-warning">
          Showing first {maxRows} rows of {bodyRows.length}. Download to see the
          full file.
        </div>
      )}
      <div className="yolo-web-csv-preview-table-wrapper">
        <table className="yolo-web-csv-preview-table">
          <thead>
            <tr>
              {headers.map((header, i) => (
                <th key={i} className="yolo-web-csv-preview-th">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {headers.map((_, colIndex) => (
                  <td key={colIndex} className="yolo-web-csv-preview-td">
                    {row[colIndex] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
