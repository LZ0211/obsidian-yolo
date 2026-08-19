import { App, TFile } from 'obsidian'

jest.mock('obsidian')

jest.mock('./imageCompress', () => ({
  // createImageBitmap / OffscreenCanvas are unavailable in jsdom; the
  // compression math is not under test here.
  compressImage: jest.fn(),
}))

import {
  IMAGE_COMPRESSION_THRESHOLD_BYTES,
  tFileToImageDataUrlWithCompression,
} from './image'
import { compressImage } from './imageCompress'

const makeImageFile = (
  path: string,
  size: number,
  extension = 'png',
  mtime = 1000,
): TFile =>
  Object.assign(new TFile(), {
    path,
    name: path.split('/').pop(),
    extension,
    stat: { size, mtime },
  })

const makeReadBinaryApp = (): App =>
  ({
    vault: {
      readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
    },
  }) as unknown as App

beforeEach(() => {
  ;(compressImage as jest.Mock).mockReset()
  ;(compressImage as jest.Mock).mockResolvedValue({
    base64: 'compressed-bytes',
    mimeType: 'image/jpeg',
  })
})

describe('tFileToImageDataUrlWithCompression', () => {
  it('returns the original image data URL when within the threshold', async () => {
    const file = makeImageFile(
      'Pics/small.png',
      IMAGE_COMPRESSION_THRESHOLD_BYTES,
    )

    const result = await tFileToImageDataUrlWithCompression(
      makeReadBinaryApp(),
      file,
      { quality: 85 },
    )

    expect(result).toEqual({
      url: expect.stringMatching(/^data:image\/png;base64,/),
      compressed: false,
    })
    expect(compressImage).not.toHaveBeenCalled()
  })

  it('compresses an oversized image and marks the result as compressed', async () => {
    const file = makeImageFile(
      'Pics/big.png',
      IMAGE_COMPRESSION_THRESHOLD_BYTES + 1,
    )

    const result = await tFileToImageDataUrlWithCompression(
      makeReadBinaryApp(),
      file,
      { quality: 60 },
    )

    expect(result).toEqual({
      url: 'data:image/jpeg;base64,compressed-bytes',
      compressed: true,
    })
    expect(compressImage).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      'png',
      60,
    )
  })

  it('skips compression for gif files even when oversized', async () => {
    const file = makeImageFile('Pics/anim.gif', 5 * 1024 * 1024, 'gif')

    const result = await tFileToImageDataUrlWithCompression(
      makeReadBinaryApp(),
      file,
      { quality: 85 },
    )

    expect(result.compressed).toBe(false)
    expect(compressImage).not.toHaveBeenCalled()
  })
})
