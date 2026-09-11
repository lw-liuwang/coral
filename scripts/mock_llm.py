#!/usr/bin/env python3
"""coral 的 mock LLM 服务器：无真实端点时的端到端联调用。

实现 POST /v1/chat/completions：
- system 含「知识库分析师」→ 返回固定中文分析文本（Step 1）
- system 含「wiki 维护者」→ 返回手工构造的 FILE 块（Step 2），
  故意混入一个恶意路径块（wiki/../evil.md）验证安全闸门

用法：python scripts/mock_llm.py [端口]
然后把 config.yaml 的 llm.base_url 指向 http://127.0.0.1:8400/v1
"""
import sys

from fastapi import FastAPI, Request

app = FastAPI()

ANALYSIS = """## 关键实体
- 张三：核心，项目负责人，新
- Coral 项目：核心，知识库系统本身，新

## 关键概念
- 知识库编译：把知识一次性整理成结构化 wiki 而非每次检索重算，重要，新
- 两步分析：先分析再生成的链式流程，重要，新

## 与现有 wiki 的关联
- wiki 目前为空，本源是第一个来源。

## 建议
- 新建 source 页：示例笔记
- 新建 entity 页：张三
- 新建 concept 页：知识库编译"""

GENERATION = """---FILE: wiki/sources/示例笔记.md---
---
type: source
title: 示例笔记
created: 2026-01-01
updated: 2026-01-01
tags: [笔记]
related: [张三, 知识库编译]
sources: ["示例笔记.md"]
---

# 示例笔记

这是一份示例笔记。项目由 [[张三]] 负责，核心思想是 [[知识库编译]]。

## 要点
1. 知识应当编译一次、持续维护
2. 采用两步分析流程

---END FILE---

---FILE: wiki/entities/张三.md---
---
type: entity
title: 张三
created: 2026-01-01
updated: 2026-01-01
tags: [人物]
related: [知识库编译]
sources: ["示例笔记.md"]
---

# 张三

项目负责人。主导 [[知识库编译]] 相关工作。

---END FILE---

---FILE: wiki/concepts/知识库编译.md---
---
type: concept
title: 知识库编译
created: 2026-01-01
updated: 2026-01-01
tags: [方法论]
related: [张三]
sources: ["示例笔记.md"]
---

# 知识库编译

把散乱文档一次性整理为结构化 wiki，后续查询直接读 wiki 而非重新推导。

```text
注意：这个代码块里的 ---END FILE--- 不应当被当作块结束符。
---END FILE---
```

---END FILE---

---FILE: wiki/../evil.md---
---
type: entity
title: 恶意页面
---

这个块应当被路径安全闸门拒绝。

---END FILE---"""


@app.post("/v1/chat/completions")
async def chat(request: Request):
    payload = await request.json()
    system = ""
    for msg in payload.get("messages", []):
        if msg.get("role") == "system":
            system = msg.get("content", "")
    if "知识库分析师" in system:
        content = ANALYSIS
    elif "wiki 维护者" in system:
        content = GENERATION
    else:
        content = "未知角色"
    return {
        "id": "mock",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0},
    }


@app.get("/v1/models")
async def models():
    return {"data": [{"id": "mock-llm"}]}


if __name__ == "__main__":
    import uvicorn
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8400
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
