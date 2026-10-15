# coral

coral 是使用 TypeScript 编写的自托管 Markdown 知识库，同时提供 Web 应用和只读 MCP 接口。一个知识库对应一个 Obsidian Vault。主要使用 Obsidian 书写，Web 用于浏览和临时修改，agent 通过 MCP 查询内容。

- 首页列出知识库，可创建独立的 Obsidian Vault；进入知识库后创建或上传 Markdown 文档。
- 按 Obsidian 文件夹浏览文档，支持临时创建、编辑、删除和实时预览 Markdown；没有固定文档分类。
- 知识库页面可直接在当前目录创建空文件夹，支持中文名称；同名文件或文件夹会提示冲突，不会覆盖现有内容。
- CodeMirror Markdown 编辑器：语法高亮、格式工具栏、撤销重做、书写/分栏/预览、专注模式；支持 Ctrl/Cmd+S 保存、Ctrl/Cmd+B/I 格式化。编辑保存后可继续书写，手机默认使用书写视图。
- 未保存内容自动保留在当前浏览器的本地草稿中，下次打开可恢复或丢弃；本地草稿不等于已写入知识库文件，保存成功后清除。恢复旧草稿同样执行文档版本校验。
- 新建文档默认保存到当前目录，也可填写库内相对目录；上传 `.md` / `.markdown` 到当前目录，同目录同名文件添加数字后缀，不同目录可同名。
- 文档和文件夹列表可直接删除；确认后移入所属 Vault 的 `.trash/<批次>/<原相对路径>`，文件夹包含附件、隐藏文件和子目录。网页回收站支持恢复、彻底删除和清空；恢复遇到同名内容时拒绝覆盖，删除前校验版本，内容已被 Obsidian 修改时要求刷新。
- 知识库也可移入回收站，立即停止网页和 MCP 访问，重启后仍保持回收状态。首页可查看全部回收内容，知识库工具菜单可查看当前库的回收站；彻底删除和清空均需确认。
- 多知识库切换，支持中文和英文全文搜索、反向链接与结构检查。
- Obsidian 直接打开同一个文件夹；网页和 MCP 查询时读取磁盘最新内容。
- MCP 支持列出知识库、列出文档、搜索、分片读取及原始文件下载。
- 所有公开文档标识均为 `coral://vault/<id>/<document>`，不会返回服务器本机路径。
- 网页写操作通过 Git 留痕，只提交本次操作涉及的路径，不会连带提交用户暂存的其他文件；编辑时校验 SHA-256 版本并保留原文件备份。

## 运行

需要 **Node.js 22.13+**，推荐 Node.js 22 或 24 LTS：

```bash
npm ci
npm run build
npm start
```

也可以运行 `bash run.sh`。默认访问 http://127.0.0.1:8300 ，MCP 端点为 http://127.0.0.1:8300/mcp 。

开发模式：`npm run dev`。后端、浏览器代码及 MCP 均使用 TypeScript；浏览器资源本地打包，无外部 CDN。SQLite 使用 Node.js 内置的 `node:sqlite`，Node.js 22 可能打印实验性 API 提示，不影响使用。

## 配置与 Obsidian

可选配置：将 `config.example.yaml` 复制为 `config.yaml`。默认读取应用目录的配置；配置中的相对路径基于配置文件所在目录，因此 Web 和从其他目录启动的 MCP 客户端会使用同一知识库。

```yaml
server:
  host: "127.0.0.1"
  port: 8300
data_dir: "./data"
vaults:
  project:
    name: "项目知识库"
    description: "项目设计与开发资料"
    path: "/your/obsidian/project"
```

默认知识库 ID 为 `default`，目录为 `data/wiki/`，保留现有文档。首页点击「创建知识库」，只需填写名称和可选简介；系统自动生成稳定的 UUID 标识，用于目录和 MCP 路径，无需手动配置。新库保存到 `data/vaults/<id>/`，每个知识库是独立文件夹。名称支持中文和重名，已有知识库标识保持不变。

新库包含 `.obsidian/` 和用于保存名称、简介的 `.coral-vault.json`，无需手动修改配置；重启后自动恢复，独立运行的 MCP 进程也会发现新库。已有 Obsidian 文件夹仍可通过配置的 `vaults` 注册。在 Obsidian 中选择「打开文件夹作为仓库」，打开对应文件夹即可；不需要导入或转换。

默认知识库和网页创建的知识库由 Coral 托管，删除整个知识库会将目录移至 `data/.coral/vault-trash/<id>/content`；恢复时移回原位置，彻底删除会删除该目录中的全部内容。通过配置接入的外部 Obsidian Vault 只回收注册记录，不移动原目录；即使彻底删除回收记录，外部文件也会保留。回收期间的知识库标识不能用于创建新库。单个文档和文件夹的回收内容留在所属 Vault 的 `.trash/`，不会参与正常列表、搜索和 MCP 查询。旧版 Coral 批次可在回收站恢复；无法识别的记录（包括 Obsidian 自行放入的原生回收文件）保留在磁盘，清空操作会跳过并提示。

```text
data/
├── vaults/               # 网页创建的知识库
│   └── project/          # 独立 Obsidian Vault
│       ├── .obsidian/
│       ├── .coral-vault.json
│       └── 任意文档.md    # 默认在根目录创建，也可指定子目录
├── wiki/                 # 默认 Obsidian Vault
│   ├── .obsidian/        # Obsidian 自行管理，coral 不读取
│   ├── 任意文档.md
│   └── 任意子目录/        # 保留 Obsidian 原有目录组织
├── sources/              # 旧版原始资料，保留只读浏览入口
└── .git/                 # 网页写操作历史
```

每个 Vault 的 Markdown 是唯一内容真源。查询时检查文件状态，复用未变化的文档解析结果；内存中的全文索引按变化更新，反向链接按文档快照缓存。重启后首次访问会重建缓存，外部新增、修改、删除仍会在下次查询时发现。支持标准 YAML 属性（含循环引用）、自定义属性、`[[文件]]`、`[[目录/文件|别名]]`、`[[文件#标题]]`、标准 Markdown 相对链接和本地图片。标准 Markdown 相对链接按当前文档目录解析，Wiki 链接保留 Vault 路径解析规则。跨目录同名文件请使用带目录的引用。已有默认 Vault 的 `index.md`、`log.md` 保留在磁盘，但不参与文档列表和搜索；外部 Vault 的同名文件正常参与。

网页编辑保存会在所属 Vault 的 `.coral-backups/<批次>/<原文件名>` 中保留保存前的文件，然后复核版本并独占创建新文件；若其他程序已重新写入原位置，则返回冲突并保留两份内容。备份不参与列表、搜索和 MCP 查询，不会自动清理，可在确认内容安全后手动清理；已有 Git 仓库建议将 `.coral-backups/` 加入忽略规则。未配合 Coral 的外部程序仍可能在保存完成后再次写入同一路径，因此备份用于保留可恢复内容，不代表跨应用的强事务锁。损坏的知识库回收状态会被隔离并提示，受影响的知识库保持隐藏，不影响其他知识库。

旧的 `notes/`、`concepts/`、`entities/`、`sources/` 不会自动创建，也不会移动或删除已有目录和文档。已有 YAML `type`、`tags` 等属性均作为普通属性保留，新建文档不再自动添加 `type`。可以在 Obsidian 中按自己的目录和标签组织内容。

隐藏文件、隐藏目录和符号链接不对外暴露。Markdown 文件大小上限为 16 MiB；文本读取要求 UTF-8，下载保持原始字节。非 UTF-8 或超大文档会在列表中报告跳过数量，非 UTF-8 文档仍可按已知 URI 下载。上传使用 UTF-8，`.markdown` 扩展名转为 `.md`。Obsidian 的插件、Canvas、Dataview、块引用和笔记嵌入不在网页执行。

环境变量优先：`CORAL_CONFIG`、`CORAL_DATA_DIR`、`CORAL_HOST`、`CORAL_PORT`。

## MCP 接入

支持官方 MCP SDK 的 **Streamable HTTP** 与 **stdio** 两种传输。MCP 完全只读，Web 可以编辑知识库。

HTTP 客户端连接：

```json
{
  "mcpServers": {
    "coral": {
      "url": "http://127.0.0.1:8300/mcp"
    }
  }
}
```

不同客户端的 HTTP 配置字段可能不同，请将该地址配置为 Streamable HTTP 服务端点。

stdio 客户端无需启动 Web，使用编译后的入口（下面的应用路径按实际位置填写）：

```json
{
  "mcpServers": {
    "coral": {
      "command": "node",
      "args": ["/path/to/coral/dist/stdio.js"],
      "env": { "CORAL_CONFIG": "/path/to/coral/config.yaml" }
    }
  }
}
```

开发时可以使用 `npm run mcp`；客户端直接执行 `node dist/stdio.js` 可避免 npm 的标准输出混入协议。

| 工具 | 参数 | 返回 |
|---|---|---|
| `list_vaults` | 无 | 名称、简介、Vault URI、可用状态、文档数量 |
| `list_documents` | `vault_id`、可选 `directory/cursor/limit` | 文档 URI、库内相对路径 `path`、标题、版本、下一页游标；包含指定目录的子目录文档 |
| `search_documents` | `query`、可选 `vault_id/cursor/limit` | 相关片段、行号、文档 URI、版本 |
| `read_document` | `uri`、可选 `offset/max_chars/heading/version` | 原始 Markdown 分片、目录、版本、下一片偏移 |
| `download_document` | `uri` | 原始文件字节（MCP embedded resource 的 Base64 blob）和文件元信息 |

建议 agent 的调用流程：

```text
list_vaults()
→ search_documents(query="索引设计", vault_id="project")
→ read_document(uri="coral://vault/project/docs/design.md")
→ 需要完整文件时调用 download_document(uri=同一个URI)
```

`read_document` 默认每片 16,000 个 UTF-16 单元，上限 64,000，`next_offset` 为 `null` 表示读取完成；继续读取时传入返回的 `version`，文件变化会报错，避免拼接不同版本。指定 `heading` 时读取唯一的 ATX 标题及其子章节，偏移相对于该章节。目录最多返回 100 个标题，具体偏移单位与 JavaScript 字符串一致。

也支持 `resources/read` 和资源模板 `coral://vault/{vault_id}/{+path}`，单个资源文本上限 1 MiB；更大的文档使用分片工具或下载工具。

普通 HTTP 文件下载同样只接受资源 URI：

```bash
curl --get 'http://127.0.0.1:8300/download' \
  --data-urlencode 'uri=coral://vault/project/docs/design.md' \
  --output design.md
```

`coral://` 是资源标识，不是操作系统路径或可直接访问的 HTTP URL。文件下载由 MCP 客户端解码 blob，或通过上面的 HTTP 端点保存。URI 中的空格、中文、`#`、`?` 等字符按标准百分号编码。

服务默认只监听本机，当前没有账号或鉴权；需要跨机器访问时，应通过带鉴权的反向代理接入。

## Docker

```bash
docker build -t coral .
docker run -d -p 8300:8300 -v /your/data:/data coral
```

更多 Vault 可通过挂载配置文件和对应目录注册。宿主机 Obsidian 打开 `/your/data/wiki/`。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

测试覆盖文件安全、Obsidian 互操作、中文搜索、文档版本、上传下载、网页操作，以及使用官方客户端进行 HTTP/stdio MCP 调用。浏览器测试：`npx playwright install chromium` 后运行 `npm run test:browser`。

## 迁移

旧版 Python 服务已由 TypeScript 替代，不再需要 Python、pip 或 LLM 配置。现有 `data/wiki/` 和额外注册的 Vault 可以直接使用，不会搬移或批量转换原文件。旧 `journal/`、`jobs/`、`coral.db` 等文件保留，但不再加载。

## License

[MIT](LICENSE)
