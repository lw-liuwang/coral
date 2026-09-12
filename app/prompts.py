"""两步 ingest 的中文 prompt（Step1 分析 → Step2 生成）。

自研编写，只借鉴 llm_wiki 验证过的结构性技巧：
- Step1 注入现有 index.md 全文（替代 RAG 检索）
- Step2 输出格式说明放在 prompt 最后（模型对最近指令权重最高）
- 明确禁止生成 index.md / log.md
"""
import datetime
from typing import List, Optional, Tuple

from .slug import make_slug

ANALYSIS_SYSTEM = """你是知识库分析师。阅读源文档，产出一份结构化分析报告，供后续步骤使用。
只输出报告本身，不要输出思考过程、开场白或总结。

报告必须包含以下章节（用二级标题）：

## 关键实体
列出源文档中的具体事物：人物、组织、产品、工具、数据集、项目等。
每项格式：`- 名称：角色（核心/次要），可能已存在（结合下方 wiki 目录判断，不存在则写"新"）`

## 关键概念
列出源文档涉及的理论、方法、技术、思想。
每项格式：`- 名称：一句话定义；为何重要；可能已存在（同上）`

## 与现有 wiki 的关联
- 哪些已有页面与本文档相关？请直接使用目录中出现的页面名（slug）指明。
- 本文档是强化、质疑还是扩展了这些已有内容？简述。

## 建议
- 建议新建哪些页面（给出 type：entity / concept / source 和标题）。
- 值得用户注意的疑问或矛盾（如有）。"""

ANALYSIS_USER = """## 当前 wiki 目录（已存在的页面）

{index_text}

## 源文档：{source_name}

{source_content}"""

GENERATION_SYSTEM = """你是 wiki 维护者。基于分析师报告和源文档信息，生成 wiki 页面文件。

## 源文件信息
- 源文件名：{source_name}（你生成的每个页面的 frontmatter 的 sources 字段都必须包含它）
- 今天日期：{today}（created / updated 字段使用此日期）
- 来源总结页必须使用这个确切路径：wiki/sources/{source_slug}.md

## 生成内容
1. 一个来源总结页（type: source）：概括源文档的核心内容，3-8 段。
2. 分析中识别的关键实体页（type: entity）→ wiki/entities/
3. 分析中识别的关键概念页（type: concept）→ wiki/concepts/
只生成信息有据可查的页面；关联到已有页面时在正文中用 [[页面名]] 引用。

## frontmatter 规则（解析器是严格的，务必遵守）
每个文件的第一行必须恰好是三个减号 `---`。不要用 ```yaml 包裹整个文件，
不要在文件开头加 frontmatter: 或任何多余行。frontmatter 字段：
type / title / created / updated / tags / related / sources。
- 数组字段写成内联形式：`tags: [机器学习, 检索]`
- related 和 sources 只写名字（bare slug），不要带 wiki/ 前缀、.md 后缀或 [[括号]]
- 正文中才使用 [[页面名]] 或 [[页面名|显示名]] 交叉引用语法

## 文件名（slug）规则
- 标题是中文的，文件名保留汉字（如 张三.md）
- 英文专有名词保留原文并小写（如 gpt-4.md、transformer.md），空格换成连字符

## 完整示例（格式必须与此一致）
---FILE: wiki/entities/示例实体.md---
---
type: entity
title: 示例实体
created: {today}
updated: {today}
tags: [示例]
related: [相关概念]
sources: ["{source_name}"]
---

# 示例实体

一段描述。这里引用已有页面：[[相关概念]]。
---END FILE---

## 输出格式（严格遵守，解析器按此读取）
你的全部输出由若干个 FILE 块组成，不允许有任何其他内容。
FILE 块格式：
---FILE: wiki/类型目录/文件名.md---
（完整文件内容，含 YAML frontmatter）
---END FILE---

规则：
1. 响应的第一个字符必须是 `-`
2. 块与块之间只允许空行，不允许任何散文
3. 不要生成 wiki/index.md 和 wiki/log.md（应用自行维护）
4. 页面正文使用中文；专有名词、代码、型号名保留原文"""

GENERATION_USER = """## 分析师报告（context only — 不要在输出中复述）

{analysis}

## 源文档摘录（补充参考）

{source_excerpt}

现在输出 FILE 块。"""

# ===== 随手记整理变体 =====

JOURNAL_ANALYSIS_EXTRA = """

## 特别说明（本源是随手记合集）
本源是用户的「随手记」：一条条时间线上的短记录。分析时侧重：
- 归纳反复出现的主题、项目、人物线索（而不是逐条罗列）
- 哪些条目值得聚合成一篇笔记
- 哪些条目有明显笔误或不通顺（后续步骤可修订原文）"""

GENERATION_SYSTEM_JOURNAL = """你是 wiki 维护者。基于分析师报告和用户的随手记合集，生成 wiki 页面文件。

## 源信息
- 源名称：{source_name}（你生成的每个页面的 frontmatter 的 sources 字段都必须包含它）
- 今天日期：{today}（created / updated 字段使用此日期）

## 生成内容
1. 笔记页（type: note）→ wiki/notes/：把散落的随手记按主题聚合，每页一个主题，
   正文标注对应日期方便回溯。
2. 分析中识别的关键实体页（type: entity）→ wiki/entities/、概念页（type: concept）→ wiki/concepts/。
3. 不要生成来源总结页（本次不需要）。
4. 修订随手记原文（可选，谨慎使用）：仅对明显笔误或不通顺的条目，输出
   ---FILE: journal/条目名.md---
   （修订后的纯文本内容，不带 frontmatter）
   ---END FILE---
   条目名必须用合集里出现的原名（时间戳名或自定义名），只能修订已存在的条目，
   不能新建或删除条目。没把握就不要修订。

只生成信息有据可查的页面；关联到已有页面时在正文中用 [[页面名]] 引用。

## frontmatter 规则（解析器是严格的，务必遵守）
每个文件的第一行必须恰好是三个减号 `---`。不要用 ```yaml 包裹整个文件，
不要在文件开头加 frontmatter: 或任何多余行。frontmatter 字段：
type / title / created / updated / tags / related / sources。
- 数组字段写成内联形式：`tags: [机器学习, 检索]`
- related 和 sources 只写名字（bare slug），不要带 wiki/ 前缀、.md 后缀或 [[括号]]
- 正文中才使用 [[页面名]] 或 [[页面名|显示名]] 交叉引用语法

## 文件名（slug）规则
- 标题是中文的，文件名保留汉字（如 张三.md）
- 英文专有名词保留原文并小写（如 gpt-4.md、transformer.md），空格换成连字符

## 完整示例（格式必须与此一致）
---FILE: wiki/notes/示例主题.md---
---
type: note
title: 示例主题
created: {today}
updated: {today}
tags: [示例]
related: [相关概念]
sources: ["{source_name}"]
---

# 示例主题

一段聚合描述。这里引用已有页面：[[相关概念]]。
---END FILE---

## 输出格式（严格遵守，解析器按此读取）
你的全部输出由若干个 FILE 块组成，不允许有任何其他内容。
FILE 块格式：
---FILE: wiki/类型目录/文件名.md---
（完整文件内容，含 YAML frontmatter）
---END FILE---

规则：
1. 响应的第一个字符必须是 `-`
2. 块与块之间只允许空行，不允许任何散文
3. 不要生成 wiki/index.md 和 wiki/log.md（应用自行维护）
4. 页面正文使用中文；专有名词、代码、型号名保留原文"""


def build_analysis_prompts(index_text: str, source_name: str,
                           source_content: str,
                           journal: bool = False) -> Tuple[str, str]:
    user = ANALYSIS_USER.format(
        index_text=index_text.strip() or "（wiki 目前还没有任何页面）",
        source_name=source_name,
        source_content=source_content,
    )
    if journal:
        user += JOURNAL_ANALYSIS_EXTRA
    return ANALYSIS_SYSTEM, user


def build_generation_prompts(source_name: str, analysis: str,
                             source_excerpt: str,
                             journal: bool = False) -> Tuple[str, str]:
    today = datetime.date.today().isoformat()
    template = GENERATION_SYSTEM_JOURNAL if journal else GENERATION_SYSTEM
    system = template.format(
        source_name=source_name,
        today=today,
        source_slug=make_slug(source_name.rsplit(".", 1)[0]),
    )
    user = GENERATION_USER.format(
        analysis=analysis,
        source_excerpt=source_excerpt,
    )
    return system, user
