import re
import subprocess
import sys


def git_show(path):
    return subprocess.run(
        ['git', 'show', f'backup/pre-rollback-2026-08-10:{path}'],
        capture_output=True,
        text=True,
        encoding='utf-8',
    ).stdout


def find_block(src, key, indent):
    m = re.search(r'^%s%s: \{' % (indent, key), src, re.M)
    if not m:
        m = re.search(r'^%s%s\?: \{' % (indent, key), src, re.M)
    if not m:
        return None, None, None
    start = src.index('{', m.start())
    depth = 0
    for i in range(start, len(src)):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                return src[m.start():i + 1], m.start(), i
    return None, None, None


def count_unclosed_quotes(text, quote):
    count = 0
    i = 0
    while i < len(text):
        if text[i] == '\\':
            i += 2
            continue
        if text[i] == quote:
            count += 1
        i += 1
    return count % 2


def extract_entry(block, key_start):
    """从键名行开始提取完整 entry（处理多行字符串值）。"""
    lines = block[key_start:].split('\n')
    first = lines[0]
    quote = None
    for ch in first[first.index(':'):]:
        if ch in "'\"`":
            quote = ch
            break
    out = [first]
    idx = 1
    while idx < len(lines):
        text = '\n'.join(out)
        if quote is None:
            if text.rstrip().endswith(',') or text.rstrip().endswith('}'):
                break
        else:
            if count_unclosed_quotes(text, quote) == 0 and (
                text.rstrip().endswith(',') or text.rstrip().endswith('}')
            ):
                break
        out.append(lines[idx])
        idx += 1
    return '\n'.join(out)


def move_working_directory(locale, sidebar_old, anchor, block):
    path = f'src/i18n/locales/{locale}.ts'
    src = open(path, encoding='utf-8').read()
    assert sidebar_old in src, f'{locale}: sidebar workingDirectory block missing'
    src = src.replace(sidebar_old, '')
    assert anchor in src, f'{locale}: anchor missing'
    src = src.replace(anchor, anchor + '\n' + block, 1)
    open(path, 'w', encoding='utf-8').write(src)
    print(locale, 'workingDirectory moved')


def backfill(locale):
    path = f'src/i18n/locales/{locale}.ts'
    backup_src = git_show(path)
    b_block, _, _ = find_block(backup_src, 'agent', '    ')
    cur_src = open(path, encoding='utf-8').read()
    c_block, c_start, c_end = find_block(cur_src, 'agent', '    ')
    if not b_block or not c_block:
        print(locale, 'SKIP block not found')
        return
    # 缩进不敏感检测（en/it 历史遗留 8-space 键），插入统一用 6-space。
    b_keys = set(re.findall(r'^\s{6}([A-Za-z]\w*)\??:', b_block, re.M))
    c_keys = set(re.findall(r'^\s{6,8}([A-Za-z]\w*)\??:', c_block, re.M))
    missing = b_keys - c_keys
    if not missing:
        print(locale, 'no missing keys')
        return
    entries = []
    for mm in re.finditer(r'^(\s{6})([A-Za-z]\w*)\??:', b_block, re.M):
        if mm.group(2) not in missing:
            continue
        entries.append(extract_entry(b_block, mm.start()))
    insert_at = c_block.rfind('\n', 0, c_block.rfind('}'))
    new_block = c_block[:insert_at] + '\n' + '\n'.join(entries) + c_block[insert_at:]
    new_src = cur_src[:c_start] + new_block + cur_src[c_end + 1:]
    open(path, 'w', encoding='utf-8').write(new_src)
    print(locale, 'inserted', len(entries), 'agent keys')


move_working_directory(
    'zh',
    """    chat: {
      exportSuccess: '已导出聊天记录到 {path}',
      exportError: '导出失败',
      workingDirectory: {
        locked: '工作目录已锁定',
        select: '选择工作目录',
        clear: '清除工作目录',
      },
    },
""",
    "    uploadFile: '添加文件',",
    """    workingDirectory: {
      select: '选择工作目录',
      clear: '清除工作目录',
      locked: '工作目录已锁定',
    },""",
)

move_working_directory(
    'en',
    """    chat: {
      exportSuccess: 'Exported chat to {path}',
      exportError: 'Could not export conversation',
      workingDirectory: {
        locked: 'Working directory is locked',
        select: 'Select working directory',
        clear: 'Clear working directory',
      },
    },
""",
    "    uploadFile: 'Add file',",
    """    workingDirectory: {
      select: 'Select working directory',
      clear: 'Clear working directory',
      locked: 'Working directory is locked',
    },""",
)

move_working_directory(
    'it',
    """    chat: {
      exportSuccess: 'Chat esportata in {path}',
      exportError: 'Impossibile esportare la conversazione',
      workingDirectory: {
        locked: 'La directory di lavoro è bloccata',
        select: 'Seleziona directory di lavoro',
        clear: 'Cancella directory di lavoro',
      },
    },
""",
    "    uploadFile: 'Aggiungi file',",
    """    workingDirectory: {
      select: 'Seleziona directory di lavoro',
      clear: 'Cancella directory di lavoro',
      locked: 'La directory di lavoro è bloccata',
    },""",
)

backfill('zh')
backfill('en')
backfill('it')
