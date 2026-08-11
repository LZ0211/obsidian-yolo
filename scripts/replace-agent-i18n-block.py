import re
import subprocess


def git_show(path):
    return subprocess.run(
        ['git', 'show', f'backup/pre-rollback-2026-08-10:{path}'],
        capture_output=True,
        text=True,
        encoding='utf-8',
    ).stdout


def find_block_range(src, key, indent):
    m = re.search(r'^%s%s: \{' % (indent, key), src, re.M)
    if not m:
        m = re.search(r'^%s%s\?: \{' % (indent, key), src, re.M)
    if not m:
        return None
    start = src.index('{', m.start())
    depth = 0
    for i in range(start, len(src)):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                return m.start(), i
    return None


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


def extract_key_entry(block, key_start):
    """从任意缩进的键名行开始提取完整 entry（处理多行值）。"""
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


def replace_agent_block(locale):
    path = f'src/i18n/locales/{locale}.ts'
    backup_src = git_show(path)
    cur_src = open(path, encoding='utf-8').read()

    b_range = find_block_range(backup_src, 'agent', '    ')
    c_range = find_block_range(cur_src, 'agent', '    ')
    if not b_range or not c_range:
        print(locale, 'SKIP block not found')
        return
    b_start, b_end = b_range
    c_start, c_end = c_range
    b_block = backup_src[b_start:b_end + 1]
    c_block = cur_src[c_start:c_end + 1]

    # backup 键（任意缩进统一为 6-space 键名）
    b_keys = set(re.findall(r'^\s{6}([A-Za-z]\w*)\??:', b_block, re.M))
    # master 特有键：仅 6-space 直接子键（8-space 子对象键由 backup 块覆盖）
    master_only = []
    seen = set()
    for mm in re.finditer(r'^(\s{6})([A-Za-z]\w*)\??:', c_block, re.M):
        name = mm.group(2)
        if name in b_keys or name in seen:
            continue
        seen.add(name)
        entry = extract_key_entry(c_block, mm.start())
        master_only.append(entry)

    # 拼装：backup 块 + master-only 键
    insert_at = b_block.rfind('\n', 0, b_block.rfind('}'))
    suffix = '\n' + '\n'.join(master_only) if master_only else ''
    new_block = b_block[:insert_at] + suffix + b_block[insert_at:]

    new_src = cur_src[:c_start] + new_block + cur_src[c_end + 1:]
    open(path, 'w', encoding='utf-8').write(new_src)
    print(locale, 'agent block replaced; master-only keys:', len(master_only))


replace_agent_block('zh')
replace_agent_block('en')
replace_agent_block('it')
