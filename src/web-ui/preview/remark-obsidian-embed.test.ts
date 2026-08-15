import { remarkObsidianEmbed } from './remark-obsidian-embed'

function textNode(value: string) {
  return { type: 'text', value } as const
}

type LooseNode = {
  type: string
  children?: LooseNode[]
  data?: { hName?: string; hProperties?: Record<string, string> }
  value?: string
}

function runTransform(
  value: string,
  filePath = 'Notes/sub/note.md',
): Array<Record<string, string>> {
  const tree: LooseNode = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [textNode(value)],
      },
    ],
  }
  remarkObsidianEmbed({ filePath })(tree as never)
  const children = tree.children?.[0]?.children ?? []
  return children
    .filter((node) => node.type === 'wikiEmbed')
    .map((node) => node.data?.hProperties ?? {})
}

describe('remarkObsidianEmbed', () => {
  it('resolves wiki embeds relative to the note folder with a vault-root fallback', () => {
    expect(runTransform('![[img.png]]')).toEqual([
      {
        'data-target': 'Notes/sub/img.png',
        'data-fallback-target': 'img.png',
        'data-kind': 'image',
        'data-alt': '',
      },
    ])
  })

  it('omits the fallback when the note is at the vault root or the target is absolute', () => {
    expect(runTransform('![[img.png]]', 'note.md')[0]).toEqual({
      'data-target': 'img.png',
      'data-kind': 'image',
      'data-alt': '',
    })
    expect(runTransform('![[/abs/img.png]]')[0]).toEqual({
      'data-target': 'abs/img.png',
      'data-kind': 'image',
      'data-alt': '',
    })
  })

  it('walks parent segments for markdown image embeds; no root fallback for parent-relative targets', () => {
    // `../` 开头的目标在 vault 根无法解析（会越出根），fallback 应缺省。
    expect(runTransform('![alt](../assets/x.png)')[0]).toEqual({
      'data-target': 'Notes/assets/x.png',
      'data-kind': 'image',
      'data-alt': 'alt',
    })
  })

  it('skips non-image/pdf extensions', () => {
    expect(runTransform('![[note.md]]')).toEqual([])
    expect(runTransform('![[audio.mp3]]')).toEqual([])
  })

  it('strips alias and anchor suffixes before resolving', () => {
    expect(runTransform('![[img.png|300]]')[0]).toEqual({
      'data-target': 'Notes/sub/img.png',
      'data-fallback-target': 'img.png',
      'data-kind': 'image',
      'data-alt': '',
    })
  })
})
