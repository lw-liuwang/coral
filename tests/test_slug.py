"""slug 规则测试。"""
from app.slug import make_slug, unique_slug


def test_chinese_kept():
    assert make_slug("张三") == "张三"
    assert make_slug("知识库编译") == "知识库编译"


def test_space_to_hyphen():
    assert make_slug("Machine Learning 入门") == "machine-learning-入门"


def test_punctuation_stripped():
    assert make_slug("GPT-4, 检索!") == "gpt-4-检索"


def test_emoji_removed():
    assert make_slug("🪸珊瑚礁") == "珊瑚礁"


def test_fullwidth_normalized():
    # NFKC 把全角 Ａ 归一成 A
    assert make_slug("ＡＢＣ") == "abc"


def test_truncate_50():
    assert len(make_slug("字" * 100)) == 50


def test_empty_fallback():
    assert make_slug("!!!") == "untitled"


def test_unique_suffix():
    taken = {"张三", "张三-2"}
    assert unique_slug("张三", taken) == "张三-3"
    assert unique_slug("李四", taken) == "李四"
