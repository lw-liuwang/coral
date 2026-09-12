# 🪸 coral

**知识如珊瑚，一点点分泌，终成礁石。**

coral 是一个轻量级的、运行在 Linux 上的 **Web 版 LLM 知识库**：

- **导入笔记** → LLM 两步分析（先理解、再生成的 chain-of-thought）→ 自动生成结构化 wiki
- **网页浏览**：Markdown 渲染、`[[wikilink]]` 跳转、frontmatter 元信息、断链标红
- **网页编辑**：实时预览编辑器，直接写回磁盘上的 Markdown 文件
- **中文全文搜索**：SQLite FTS5 + CJK 逐字切分（零外部依赖）
- **结构检查（Lint）**：断链、孤儿页发现

理念源自 [Karpathy 的 llm-wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)：
知识**编译一次、持续维护**，而非每次查询重新推导。Markdown 文件是知识的唯一真源，
数据库只是可随时重建的索引。

## 快速开始

```bash
bash run.sh          # 创建 venv → 装依赖 → 启动，访问 http://127.0.0.1:8300
```

Docker：

```bash
docker build -t coral .
docker run -d -p 8300:8300 -v /your/data:/data coral
```

依赖：Python 3.9+（仅 8 个 pip 包：fastapi / uvicorn / jinja2 / PyYAML / httpx /
python-multipart / Markdown / Pygments）。无 Node.js、无前端构建、无外部 CDN。

## 配置 LLM

编辑 `config.yaml`，把 `llm.base_url` 指向任意 OpenAI 兼容端点（vLLM / 内网推理服务）：

```yaml
llm:
  base_url: "http://127.0.0.1:8000/v1"
  api_key: ""                  # 内网自部署端点通常留空
  model: "qwen2.5-32b-instruct"
  max_output_tokens: 8192
```

### 没有真实端点？用 mock 联调

```bash
python scripts/mock_llm.py 8400      # 启动假 LLM（含一个恶意路径块，验证安全闸门）
# config.yaml: llm.base_url 改为 http://127.0.0.1:8400/v1
```

## 使用流程

### 两种记录方式（面向日常使用）

1. **日记**：首页直接写（心情、今天发生的事），每天自动归档到一个文件 `journal/YYYY-MM-DD.md`，首页下方按时间线回顾
2. **求职跟踪**：求职页记每次投递（公司/岗位/日期），一行一条；点开记录可**推进状态**（待投→已投→笔试→面试→offer/挂）并**追加复盘**；表格自动把最接近面试时间的排最前，已结束的沉底

### 知识库（LLM 整理）

1. **资料**页上传笔记（`.md` / `.markdown` / `.txt`），勾选「自动导入」
2. **整理**页查看两步管线进度（分析 → 生成 → 落盘）
3. **知识库**页浏览生成的 wiki，点击 `[[链接]]` 穿行
4. 随时在网页上**编辑**任何页面（保存 = 写回 Markdown 文件）
5. **体检**页看断链 / 孤儿页，顺手补页面
6. 顶栏**搜索**覆盖全部：日记、投递记录、wiki 页面、资料原文

## 数据布局

```
data/
├── journal/          # 日记：每天一个文件（YYYY-MM-DD.md）
├── jobs/             # 求职投递记录（每次投递一个文件，含状态时间线）
├── sources/          # 你导入的原始笔记（不可变，LLM 只读）
├── wiki/
│   ├── entities/     # 人物、组织、产品、工具…
│   ├── concepts/     # 理论、方法、技术…
│   ├── notes/        # 随手记（不想分类时的人工笔记，可一键转为概念/实体）
│   ├── sources/      # 每份来源的总结页
│   ├── index.md      # 内容目录（应用自动维护）
│   └── log.md        # 操作日志（应用自动维护）
└── coral.db          # FTS 索引 + ingest 历史（可随时重建）
```

## Ingest 管线（两步 Chain-of-Thought）

```
源文件 → Step1 分析（注入现有 index.md，产出实体/概念/关联报告）
       → Step2 生成（输出 ---FILE: wiki/path.md--- 文本块）
       → 应用裁决落盘：
           · 路径闸门：必须 wiki/ 下、无 ../、非绝对路径（防注入）
           · union 字段（tags/related/sources）做并集
           · locked 字段（type/title/created）保留旧值
           · 单源页面重新 ingest → 直接替换（幂等）
           · 多源页面 → 追加「来自《源》的补充」小节
       → 重建 index.md、追加 log.md、更新 FTS
```

原则：**LLM 提议，应用裁决**。LLM 输出一律视为不可信输入，坏块只拒绝不放弃整个任务，
所有告警显示在导入历史里。

## 测试

```bash
source venv/bin/activate
pip install pytest
pytest tests/ -v
```

## 路线图（v2）

- Chat RAG 问答（带引用）
- 知识图谱可视化
- PDF / Word 导入
- 向量语义搜索
- 长文档分块 ingest
