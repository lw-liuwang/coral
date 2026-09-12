"""FILE 块解析器：LLM Step2 输出 -> 页面块列表。

逐行状态机（非单一正则），处理已知的边界情况：
- CRLF 行尾（统一成 LF）
- opener/closer 的空格/大小写变体（`--- FILE: x ---` / `--- END FILE ---`）
- 代码围栏（``` / ~~~）内的字面 closer/opener 不生效
- 流截断（最后一块未闭合）→ 丢弃 + warning
- 路径不安全 → 拒绝整块 + warning（防 prompt 注入写任意文件的第一道闸门）
"""
import re
from typing import List, NamedTuple, Optional, Tuple

from .paths import is_safe_ingest_path, normalize_ingest_path

OPENER_RE = re.compile(r"^-{3,}\s*FILE\s*:\s*(.+?)\s*-{3,}\s*$", re.IGNORECASE)
CLOSER_RE = re.compile(r"^-{3,}\s*END\s+FILE\s*-{3,}\s*$", re.IGNORECASE)
FENCE_RE = re.compile(r"^(`{3,}|~{3,})")


class FileBlock(NamedTuple):
    path: str
    content: str


def parse_file_blocks(text: str,
                      allowed_roots: tuple = ("wiki",)) -> Tuple[List[FileBlock], List[str]]:
    """解析 LLM 输出 -> (blocks, warnings)。不安全的路径直接拒绝。"""
    warnings: List[str] = []
    blocks: List[FileBlock] = []

    lines = text.replace("\r\n", "\n").split("\n")
    fence_char: Optional[str] = None    # 当前围栏字符（"`" 或 "~"）
    current_path: Optional[str] = None
    current_lines: List[str] = []

    for line in lines:
        stripped = line.strip()

        # 围栏内：一切行都属于块内容（包括字面 closer）
        if fence_char is not None:
            if current_path is not None:
                current_lines.append(line)
            if stripped.startswith(fence_char * 3):
                fence_char = None
            continue

        # 围栏外遇到围栏开头：进入围栏状态
        m = FENCE_RE.match(stripped)
        if m:
            fence_char = "`" if m.group(1).startswith("`") else "~"
            if current_path is not None:
                current_lines.append(line)
            continue

        # closer（仅在围栏外、块内生效）
        if current_path is not None and CLOSER_RE.match(stripped):
            _finish(blocks, warnings, current_path, current_lines)
            current_path, current_lines = None, []
            continue

        # opener（仅在无活跃块时生效）
        if current_path is None:
            opener = OPENER_RE.match(stripped)
            if opener:
                raw_path = opener.group(1).strip()
                if not is_safe_ingest_path(raw_path, allowed_roots):
                    warnings.append(f"拒绝不安全路径的块: {raw_path!r}")
                else:
                    current_path = normalize_ingest_path(raw_path)
                    current_lines = []
                continue

        # 块内普通行
        if current_path is not None:
            current_lines.append(line)

    if current_path is not None:
        warnings.append(f"输出被截断，丢弃未闭合的块: {current_path}")

    return blocks, warnings


def _finish(blocks: List[FileBlock], warnings: List[str],
            path: str, lines: List[str]) -> None:
    content = "\n".join(lines).strip("\n")
    if not content:
        warnings.append(f"空内容块已跳过: {path}")
        return
    blocks.append(FileBlock(path=path, content=content + "\n"))
