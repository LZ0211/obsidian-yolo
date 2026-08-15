import { loadEmbedBlob } from './WikiEmbed'

describe('loadEmbedBlob', () => {
  it('returns the primary target when it loads', async () => {
    const blob = {} as Blob
    const onLoadBinary = jest.fn(async (path: string) => {
      expect(path).toBe('Notes/img.png')
      return blob
    })

    await expect(
      loadEmbedBlob('Notes/img.png', 'img.png', onLoadBinary),
    ).resolves.toBe(blob)
    expect(onLoadBinary).toHaveBeenCalledTimes(1)
  })

  it('falls back to the vault-root target when the primary fails', async () => {
    const blob = {} as Blob
    const onLoadBinary = jest.fn(async (path: string) => {
      if (path === 'Notes/img.png') throw new Error('not found')
      return blob
    })

    await expect(
      loadEmbedBlob('Notes/img.png', 'img.png', onLoadBinary),
    ).resolves.toBe(blob)
    expect(onLoadBinary).toHaveBeenCalledTimes(2)
    expect(onLoadBinary).toHaveBeenLastCalledWith('img.png')
  })

  it('rethrows the primary error when there is no fallback', async () => {
    const onLoadBinary = jest.fn(async () => {
      throw new Error('not found')
    })

    await expect(
      loadEmbedBlob('Notes/img.png', null, onLoadBinary),
    ).rejects.toThrow('not found')
    expect(onLoadBinary).toHaveBeenCalledTimes(1)
  })

  it('rejects when both candidates fail', async () => {
    const onLoadBinary = jest.fn(async () => {
      throw new Error('missing')
    })

    await expect(
      loadEmbedBlob('Notes/img.png', 'img.png', onLoadBinary),
    ).rejects.toThrow('missing')
    expect(onLoadBinary).toHaveBeenCalledTimes(2)
  })
})
