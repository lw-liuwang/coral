# coral

以 Obsidian 仓库为核心的自托管知识库。Markdown 文件是内容真源，Obsidian 用于日常书写，Web 用于浏览和编辑，agent 通过只读 MCP 查询。

- 按文件夹管理知识，支持 Markdown 创建、上传、编辑、下载和回收站。
- CodeMirror 编辑器提供语法高亮、实时预览、撤销重做和浏览器本地草稿。
- 支持中文全文搜索、反向链接、Wiki 链接和结构检查。
- Web 和 MCP 读取磁盘上的最新内容，可与 Obsidian 同时使用。

## 目录

```text
coral/
├── obsdian/              # 独立的 Obsidian 知识仓库
│   ├── kernel/
│   │   ├── .obsidian/
│   │   ├── .coral-vault.json
│   │   └── 任意文档.md
│   └── tpu/
├── .coral/               # 知识库回收状态
├── sys/                  # 系统代码与运行环境
│   ├── src/
│   ├── static/
│   ├── tests/
│   ├── config.example.yaml
│   ├── package.json
│   └── run.sh
├── README.md
└── LICENSE
```

仓库统一放在 `obsdian/<英文名>/`，目录拼写为 `obsdian`。在 Obsidian 中选择「打开文件夹作为仓库」，直接打开 `obsdian/kernel/` 等目录。

网页创建仓库时，名称转为小写并直接作为目录名和 ID。名称须以英文字母开头，可包含字母、数字、连字符和下划线，最长 64 字符；同名仓库、目录或回收站中的名称不会被覆盖。文档标题、正文、子目录和简介可使用中文。

直接放入 `obsdian/` 的英文名仓库会被自动识别，无需先在网页注册。`.coral-vault.json` 可保存稳定 ID 和简介；首次启动会创建 `obsdian/default/`，已删除的默认仓库不会在重启时重新创建。

## 运行

需要 **Node.js 22.13+** 和 npm，推荐 Node.js 22 或 24 LTS。项目根目录执行：

```bash
bash sys/run.sh
```

脚本会安装缺少的依赖、构建并启动服务。Web 地址为 http://127.0.0.1:8300 ，MCP 端点为 http://127.0.0.1:8300/mcp 。

手动运行或开发时，npm 命令均在 `sys/` 内执行：

```bash
cd sys
npm ci
npm run build
npm start
```

开发模式使用 `npm run dev`。浏览器资源本地打包，无外部 CDN。全文索引保存在内存中，重启后自动重建；Node.js 22 可能打印内置 SQLite 的实验性 API 提示。

系统共用一个 `VaultRegistry` 管理仓库发现、文件操作、回收站和搜索；Web 与 MCP 直接调用同一套逻辑。`markdown.ts` 处理渲染和链接，`views.ts` 生成页面，`client.ts` 与 `editor.ts` 处理浏览器交互。文档扫描缓存未变化的文件，磁盘文件始终是内容真源。

## 配置

默认无需配置。自定义时，将 `sys/config.example.yaml` 复制为 `sys/config.yaml`：

```yaml
server:
  host: "127.0.0.1"
  port: 8300
data_dir: ".."
search:
  results_per_page: 20
vaults: {}
```

`data_dir` 默认指向项目根目录，仓库位于其 `obsdian/` 下，运行状态位于其 `.coral/` 下。配置中的相对路径基于配置文件所在目录，Web 和从其他目录启动的 MCP 使用相同的数据位置。外部仓库可通过 `vaults` 注册，配置项为 `name`、`description`、`path`。

环境变量优先于配置：`CORAL_CONFIG` 指定配置文件，`CORAL_DATA_DIR` 指定数据根目录，`CORAL_HOST` 和 `CORAL_PORT` 指定监听地址及端口。

## 内容与历史

支持 YAML 属性、`[[文件]]`、`[[目录/文件|别名]]`、标题链接、标准 Markdown 相对链接和本地图片。文档没有固定分类，`index.md`、`log.md` 也是普通文档。跨目录同名文件应使用带目录的引用。

网页写操作在每个仓库自己的 `.git/` 中留痕，仅提交本次涉及的路径。编辑时校验文档版本，保存前的原文件保留在 `.coral-backups/` 中；备份不参与查询，也不会自动清理。外部程序仍可能再次修改文件，备份用于保留可恢复内容。

删除文件或文件夹会移入所属仓库的 `.trash/`；删除整个托管仓库会移入 `.coral/vault-trash/`。网页回收站支持恢复、彻底删除和清空，恢复遇到同名内容时拒绝覆盖。外部仓库只回收注册记录，不移动或删除原目录。

文件回收站仅管理带有效 `.coral-trash.json` 的 Coral 记录，无法识别的内容会跳过并保留。彻底删除外部仓库注册后，其配置 ID 仍被保留；重新使用该 ID 前需更新配置。

`.coral/` 保存知识库回收状态，不应随意删除。知识仓库、运行状态和本机配置由根目录 `.gitignore` 排除，各仓库独立管理版本历史。

隐藏文件、隐藏目录和符号链接不对外暴露。Markdown 文件上限为 16 MiB，文本读取要求 UTF-8，下载保留原始字节。Obsidian 插件、Canvas、Dataview 和笔记嵌入不在网页执行。

## MCP

支持 Streamable HTTP 和 stdio，MCP 完全只读。HTTP 客户端连接：

```json
{
  "mcpServers": {
    "coral": {
      "url": "http://127.0.0.1:8300/mcp"
    }
  }
}
```

stdio 无需先启动 Web；构建后使用绝对路径启动，路径按实际安装位置填写：

```json
{
  "mcpServers": {
    "coral": {
      "command": "node",
      "args": ["/path/to/coral/sys/dist/stdio.js"]
    }
  }
}
```

| 工具 | 参数 | 返回 |
|---|---|---|
| `list_vaults` | 无 | 仓库名称、简介、URI、状态、文档数量 |
| `list_documents` | `vault_id`，可选 `directory/cursor/limit` | 文档 URI、相对路径、标题、版本和分页信息 |
| `search_documents` | `query`，可选 `vault_id/cursor/limit` | 相关片段、行号、URI 和版本 |
| `read_document` | `uri`，可选 `offset/max_chars/heading/version` | 原始 Markdown 分片、目录和分页信息 |
| `download_document` | `uri` | 原始文件字节，以 Base64 blob 返回 |

文档标识为 `coral://vault/<id>/<文件相对路径>`，不暴露服务器本机路径。例如 `coral://vault/kernel/docs/design.md`。读取大文档时，使用 `next_offset` 继续并传回 `version`，避免混合不同版本的内容；HTTP 下载端点为 `/download?uri=<编码后的URI>`。

服务默认仅监听本机，目前没有账号或鉴权；跨机器访问应通过带鉴权的反向代理接入。

## 验证

```bash
cd sys
npm run typecheck
npm test
npm run build
```

测试覆盖文件安全、Obsidian 互操作、中文搜索、版本校验、回收站、网页操作及 HTTP/stdio MCP。浏览器测试先运行 `npx playwright install chromium`，再运行 `npm run test:browser`。

## License

[MIT](LICENSE)
