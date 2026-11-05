# coral

Coral 是一个自托管知识库，直接读写磁盘上的 Markdown 文件。你可以在 Obsidian 里写笔记，在网页里阅读和编辑，也可以让 Agent 通过 MCP 搜索、创建和修改文档。这几种方式使用同一份文件。

网页可以创建、上传、编辑和下载 Markdown 文档，支持按文件夹浏览、中文全文搜索、连续阅读、文件和文件夹重命名，以及回收站。编辑器使用 CodeMirror，支持语法高亮、实时预览、撤销重做和浏览器本地草稿。文档中的公式、Mermaid 图和 HTML 交互图都可以在网页里查看。

## 启动

需要 **Node.js 22.13+** 和 npm，推荐 Node.js 22 或 24 LTS。建议同时安装 Git，用于保存网页写操作的版本历史。

### Windows

安装 Node.js 后，双击项目根目录的 `run.cmd`，或在 PowerShell 中执行：

```powershell
.\run.cmd
```

脚本会检查 Node.js 版本。如果缺少 `sys/node_modules/`，会先执行 `npm ci`，再构建并启动服务。无需安装 Bash 或 WSL。

运行时保留终端窗口，按 `Ctrl+C` 停止。出错时窗口会保留错误信息。更新项目依赖后，在 `sys/` 中执行 `npm.cmd ci` 重新安装。

### Linux / macOS

在项目根目录执行：

```bash
bash sys/run.sh
```

脚本会安装缺少的依赖、构建并启动服务。

启动后，打开 [http://127.0.0.1:8300](http://127.0.0.1:8300)。MCP 地址是 [http://127.0.0.1:8300/mcp](http://127.0.0.1:8300/mcp)。

服务默认只监听本机，目前没有账号或鉴权。需要跨机器访问时，应通过带鉴权的反向代理接入。

## 管理知识库

知识库放在 `obsdian/<英文名>/` 下，注意目录拼写是 `obsdian`。在 Obsidian 中选择「打开文件夹作为仓库」，打开对应目录，例如 `obsdian/kernel/`，就能使用同一份笔记。Web 和 MCP 会读取磁盘上的最新内容，可以与 Obsidian 同时使用。

你可以在网页上创建知识库，也可以直接把已有仓库放进 `obsdian/`，Coral 会自动识别其中使用英文名的仓库，无需先注册。

网页创建知识库时，名称会转成小写，并用作目录名和 ID。名称须以英文字母开头，可包含字母、数字、连字符和下划线，最长 64 字符。同名仓库、目录或回收站中的名称不会被覆盖。文档标题、正文、子目录和知识库简介可以使用中文。`.coral-vault.json` 可保存稳定 ID 和简介。

首次启动时，如果还没有 `obsdian/`，Coral 会创建 `obsdian/default/`。如果 `obsdian/` 已经存在，则不会重新创建你手动删除的默认仓库。

在磁盘上新增、删除或重命名知识库后，点击知识库列表右上角的刷新图标即可重新扫描。手动删除的托管仓库会从列表中移除，不会进入 Coral 回收站。

通过配置注册的外部仓库，如果路径无法访问，列表仍会显示「暂不可用」。你可以恢复路径，也可以在网页上删除它的注册记录。

## 阅读、搜索和整理文档

每个目录中的 `index.md` 或 `index.markdown` 优先显示，不区分大小写，方便从索引开始阅读；之后先列文件夹，再列其他文档。其他文件和文件夹按名称自然排序，例如 `09`、`10`、`11`、`99`、`100`，无需为了三位编号修改原有文件名。MCP 列表使用相同的排序规则。

文末提供「上一篇 / 下一篇」，显示相邻文档的标题和当前篇目位置，按同一目录中的顺序切换。点击顶部的「所在目录」会定位到当前文档。目录页会标出上次打开的文档，并提供「继续阅读」和「下一篇」。

阅读位置按目录保存在当前浏览器中，刷新或重新打开后仍可继续。这里记录的是上次打开的位置，不代表已经读完，也不会跨浏览器同步。

搜索支持中文全文检索。文档也支持反向链接和结构检查，方便查找引用关系与链接问题。文档没有固定分类；`index.md` 只是排序靠前，仍可像其他文档一样编辑、搜索和删除。

目录页、文档页和编辑页都显示完整的逐级路径，可以点击目录返回。页面不直接展示 Coral URI，只提供复制按钮；复制结果是编码后的标准 URI，方便传给 Agent 或其他程序。文件夹和文档都可以复制 `coral://vault/<id>/<相对路径>` URI。

网页和 MCP 都能重命名文件或文件夹，位置仍在原父目录中。文档需保留 `.md` 或 `.markdown` 扩展名。同名或版本冲突时，操作会被拒绝；正文、YAML 属性和附件会保留。重命名会改变路径和 URI，但不会修改 YAML 中的标题，也不会自动更新其他笔记中的链接。

## 文档格式

支持 YAML 属性、`[[文件]]`、`[[目录/文件|别名]]`、标题链接、标准 Markdown 相对链接和本地图片。跨目录引用同名文件时，应写明目录。

### 公式

文档页和编辑预览使用本地 KaTeX 渲染公式：

- 行内公式用 `$x_i$`。
- 独立公式用各占一行的 `$$` 包围 LaTeX。
- 也支持 `\(...\)`、`\[...\]` 和 `math` 代码块。

分数、根号、求和、矩阵和多行对齐都可以使用。反引号和 `text` / `latex` 代码块只展示源码，写公式时不要用它们包围。样式和字体由本地服务提供，无需模型或 CDN。

Agent 可以调用 `get_writing_guide({topic:"math"})` 获取公式规则和完整示例。

### 图表

推荐用 HTML 绘制图表，适合需要调整布局、样式或增加交互的内容。把 HTML 片段或完整 HTML 文档放进 `html` 代码块，网页就会渲染它，例如：

````markdown
```html
<style>button { padding: 12px 20px; border-radius: 8px; }</style>
<button onclick="this.textContent = '已切换状态'">点击交互</button>
```
````

HTML、CSS、JavaScript、SVG 和 Canvas 在独立沙箱中运行。文档页和编辑预览都支持交互，图块高度会随内容调整，下方可以展开查看源码。完整示例见 [HTML 交互架构图](sys/examples/interactive-html.md)，把示例 Markdown 上传到知识库即可体验。

HTML 图块需要自包含：不加载外部脚本、样式、字体或网络数据。图片可以用 data URI，图标可以用内联 SVG。脚本不能访问 Coral 页面、登录状态或本地存储，也不能调用 Coral API、提交表单或打开嵌套页面。

内容过高时会在图块内滚动。使用 `100vh` 或固定高度的图表，需要自行设置合适的容器高度。HTML 图块不需要模型或新增依赖，Obsidian 也不会执行其中的交互脚本。

如果只想展示 HTML 源码，把代码块标记写成 `html source`。直接写在普通 Markdown 中的 HTML 仍按文本显示。

Mermaid 也受支持：使用 `mermaid` 代码块即可在文档页和编辑预览中显示。渲染器在本地打包、按需加载；遇到语法错误时，页面会提示并保留源码。

### 文件限制

Markdown 文件上限为 16 MiB，文本读取要求 UTF-8，下载时保留原始字节。隐藏文件、隐藏目录和符号链接不对外暴露。Obsidian 插件、Canvas、Dataview 和笔记嵌入不会在网页中执行。

## 保存、备份和删除

网页和 MCP 的写操作会在每个知识库自己的 `.git/` 中保存历史，只提交本次涉及的路径。编辑时会校验文档版本，保存前的原文件会备份到 `.coral-backups/`。备份不参与查询，也不会自动清理。外部程序仍可能再次修改文件，备份用于保留可恢复的内容。

通过 Coral 删除文件或文件夹时，内容会移入所属知识库的 `.trash/`；删除整个托管知识库时，会移入 `.coral/vault-trash/`。网页回收站支持恢复、彻底删除和清空。恢复时如果遇到同名内容，会拒绝覆盖。

外部仓库只回收注册记录，不移动或删除原目录。彻底删除外部仓库注册后，配置中的 ID 仍会保留；重新使用该 ID 前，需要更新配置。

文件回收站只管理带有效 `.coral-trash.json` 的 Coral 记录。无法识别的内容会跳过并保留。

`.coral/` 保存知识库回收状态，不应随意删除。项目根目录的 `.gitignore` 默认排除知识仓库、运行状态和本机配置，各知识库独立管理版本历史。

## 连接 MCP

MCP 支持 Streamable HTTP 和 stdio，两种方式都能读写知识库。

### HTTP

先启动 Coral，再在客户端中配置：

```json
{
  "mcpServers": {
    "coral": {
      "url": "http://127.0.0.1:8300/mcp"
    }
  }
}
```

### stdio

stdio 不需要先启动 Web。构建项目后，使用绝对路径启动，下面的路径按实际安装位置填写：

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

### Agent 如何获取使用说明

连接时，Coral 会通过 `instructions` 说明工作流程和关键限制。`create_document`、`update_document` 及其 `content` 参数的描述中也会提示写作规则。

Agent 可以调用 `get_writing_guide({})` 获取完整指南，或用 `topic` 选择需要的部分：

| `topic` | 内容 |
|---|---|
| `workflow` | 读写流程、分页和版本冲突 |
| `writing` | 书写规则和图表选择 |
| `links` | 链接和附件 |
| `math` | 公式语法和 JSON 转义 |
| `mermaid` | Mermaid 语法和限制 |
| `html` | HTML 交互和沙箱限制 |
| `examples` | 可复制的示例 |

完整指南也通过 MCP 资源 `coral://guide/authoring` 提供，维护源文件是 [Agent 写作与调用指南](sys/docs/agent-writing-guide.md)。客户端即使不展示 MCP resources，也能调用 `get_writing_guide`，无需访问服务器文件系统。

指南建议 Agent 写作前先查阅规则，推荐用 HTML 创建和修改图表；编辑涉及已有图表时，也尽量转成 HTML，保留原有含义与关系，并注意美观、清晰和适当的交互。Mermaid 仍可使用。指南要求尊重用户指示，不会授权额外的写操作。

更新 HTTP 服务后，需要手动重启；使用 stdio 时，需要重启客户端的 MCP 子进程。之后在 Agent 客户端重新连接或刷新工具列表，才能收到新的连接说明和工具定义。客户端是否展示、是否遵循这些说明，取决于客户端实现；Coral 不会强制执行文风或图表偏好。

### 可用工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `get_writing_guide` | 可选 `topic`，默认 `all` | 写作规范、调用流程、公式、链接规则、Mermaid/HTML 限制与完整示例 |
| `list_vaults` | 无 | 仓库名称、简介、URI、状态、文档数量 |
| `list_documents` | `vault_id`，可选 `directory/cursor/limit` | 文档 URI、相对路径、标题、版本和分页信息 |
| `search_documents` | `query`，可选 `vault_id/cursor/limit` | 相关片段、行号、URI 和版本 |
| `read_document` | `uri`，可选 `offset/max_chars/heading/version` | 原始 Markdown 分片、目录和分页信息 |
| `download_document` | `uri` | 原始文件字节，以 Base64 blob 返回 |
| `browse_directory` | `vault_id`，可选 `directory/cursor/limit` | 当前目录的文件夹和文档元信息，含目录版本、URI 和分页信息 |
| `create_vault` | `name`，可选 `description` | 新知识库 ID、简介和 URI |
| `delete_vault` | `vault_id/version` | 将知识库移入回收站；外部库仅回收注册 |
| `create_directory` | `vault_id/name`，可选 `directory` | 新文件夹的相对路径和 URI |
| `delete_directory` | `uri/version` | 将文件夹及其文档、附件移入回收站 |
| `rename_directory` | `uri/name/version` | 重命名文件夹，返回新路径、URI 和版本 |
| `create_document` | `vault_id/title`，可选 `content/directory/filename` | 新文档 URI、版本和元信息；`filename` 是不含 `.md` 的文件名 |
| `update_document` | `uri/content/version` | 更新后的文档 URI、版本和元信息 |
| `delete_document` | `uri/version` | 将文档移入回收站 |
| `rename_document` | `uri/name/version` | 重命名文档文件，`name` 包含 Markdown 扩展名，返回新路径和 URI |
| `list_trash` | 可选 `vault_id` | 文件、文件夹和知识库的回收记录及版本 |
| `restore_trash` | `vault_id/entry_id/version` | 恢复回收的文件或文件夹，拒绝同名覆盖 |
| `restore_vault` | `vault_id/version` | 恢复回收的知识库或外部注册 |

### 读写时要注意什么

`create_document.content` 和 `update_document.content` 都是完整 Markdown，可以包含 YAML 属性。创建时以 `title` 为标题，自动维护创建和更新日期；同名文件会使用数字后缀。修改时保留文件位置，如果省略 YAML 属性块，则保留现有属性。

修改大文档前，必须读完所有分片，避免用局部正文覆盖全文。继续读取时使用 `next_offset`，并传回 `version`，避免混合不同版本的内容。

修改和删除都需要最新的 `version`，获取位置如下：

| 操作对象 | 从哪里获取版本 |
|---|---|
| 文档 | `read_document` 或 `list_documents` |
| 目录 | `browse_directory` |
| 知识库 | `list_vaults` |
| 回收记录 | `list_trash` |

版本冲突时，操作会被拒绝，需要重新读取后再修改。MCP 删除操作都会进入回收站；彻底删除和清空回收站仍需通过网页执行。

文档标识使用 `coral://vault/<id>/<文件相对路径>`，例如 `coral://vault/kernel/docs/design.md`，不会暴露服务器本机路径。HTTP 下载端点为 `/download?uri=<编码后的URI>`。

## 配置

默认无需配置。需要修改时，把 `sys/config.example.yaml` 复制为 `sys/config.yaml`：

```yaml
server:
  host: "127.0.0.1"
  port: 8300
data_dir: ".."
search:
  results_per_page: 20
vaults: {}
```

`data_dir` 默认指向项目根目录。知识库放在它的 `obsdian/` 下，运行状态放在 `.coral/` 下。配置中的相对路径以配置文件所在目录为基准，因此 Web 和从其他目录启动的 MCP 会使用相同的数据位置。

已有的外部仓库可以通过 `vaults` 注册，配置项为 `name`、`description` 和 `path`。

环境变量优先于配置文件：

| 环境变量 | 用途 |
|---|---|
| `CORAL_CONFIG` | 指定配置文件 |
| `CORAL_DATA_DIR` | 指定数据根目录 |
| `CORAL_HOST` | 指定监听地址 |
| `CORAL_PORT` | 指定端口 |

## 开发和测试

手动运行或开发时，npm 命令都在 `sys/` 内执行：

```bash
cd sys
npm ci
npm run build
npm start
```

开发模式使用 `npm run dev`。浏览器资源在本地打包，不使用外部 CDN。全文索引保存在内存中，重启后自动重建；文档扫描会缓存没有变化的文件，内容仍以磁盘文件为准。Node.js 22 可能打印内置 SQLite 的实验性 API 提示。

检查类型、运行测试和构建：

```bash
cd sys
npm run typecheck
npm test
npm run build
```

测试覆盖文件安全、Obsidian 互操作、中文搜索、版本校验、回收站、网页操作及 HTTP/stdio MCP。浏览器测试先运行 `npx playwright install chromium`，再运行 `npm run test:browser`。

## License

[MIT](LICENSE)
