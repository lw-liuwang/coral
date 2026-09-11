"""FILE 块解析器测试（含恶意路径、截断、围栏内 closer）。"""
from app.fileblocks import parse_file_blocks


def test_basic_blocks():
    text = (
        "---FILE: wiki/entities/a.md---\n内容A\n---END FILE---\n\n"
        "---FILE: wiki/concepts/b.md---\n内容B\n---END FILE---\n"
    )
    blocks, warns = parse_file_blocks(text)
    assert [b.path for b in blocks] == ["wiki/entities/a.md", "wiki/concepts/b.md"]
    assert "内容A" in blocks[0].content
    assert not warns


def test_crlf_normalized():
    text = "---FILE: wiki/x.md---\r\n内容\r\n---END FILE---\r\n"
    blocks, _ = parse_file_blocks(text)
    assert len(blocks) == 1
    assert "\r" not in blocks[0].content


def test_closer_variants():
    text = "---FILE: wiki/x.md---\n内容\n--- END FILE ---\n"
    blocks, _ = parse_file_blocks(text)
    assert len(blocks) == 1


def test_case_insensitive():
    text = "--- file : wiki/x.md ---\n内容\n--- end file ---\n"
    blocks, _ = parse_file_blocks(text)
    assert len(blocks) == 1


def test_truncated_block_dropped():
    text = "---FILE: wiki/a.md---\n内容\n---END FILE---\n---FILE: wiki/b.md---\n未写完"
    blocks, warns = parse_file_blocks(text)
    assert len(blocks) == 1
    assert any("截断" in w for w in warns)


def test_malicious_paths_rejected():
    for path in ("wiki/../evil.md", "/etc/passwd", "raw/sources/x.md",
                 "wiki/a/../b.md", "", "C:/x.md"):
        text = f"---FILE: {path}---\n内容\n---END FILE---\n"
        blocks, _ = parse_file_blocks(text)
        assert blocks == [], f"危险路径未被拒绝: {path}"


def test_backslash_path_rejected():
    text = "---FILE: wiki\\\\..\\\\evil.md---\n内容\n---END FILE---\n"
    blocks, warns = parse_file_blocks(text)
    assert blocks == []


def test_closer_inside_fence_not_effective():
    text = (
        "---FILE: wiki/x.md---\n"
        "开头\n"
        "```text\n"
        "---END FILE---\n"
        "```\n"
        "结尾\n"
        "---END FILE---\n"
    )
    blocks, _ = parse_file_blocks(text)
    assert len(blocks) == 1
    assert "---END FILE---" in blocks[0].content  # 围栏内的字面量保留在内容里


def test_stray_text_outside_blocks_ignored():
    text = "好的，以下是文件：\n\n---FILE: wiki/x.md---\n内容\n---END FILE---\n\n希望有帮助！"
    blocks, _ = parse_file_blocks(text)
    assert len(blocks) == 1


def test_empty_content_block_skipped():
    text = "---FILE: wiki/x.md---\n\n\n---END FILE---\n"
    blocks, warns = parse_file_blocks(text)
    assert blocks == []
    assert any("空" in w for w in warns)
