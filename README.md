# coral

以 Obsidian 仓库为核心的自托管知识库。Markdown 文件是内容真源，Obsidian 用于日常书写，Web 用于浏览和编辑，agent 通过 MCP 查询和管理知识。

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
├── run.cmd              # Windows 一键安装依赖并启动
├── README.md
└── LICENSE
```

仓库统一放在 `obsdian/<英文名>/`，目录拼写为 `obsdian`。在 Obsidian 中选择「打开文件夹作为仓库」，直接打开 `obsdian/kernel/` 等目录。

网页创建仓库时，名称转为小写并直接作为目录名和 ID。名称须以英文字母开头，可包含字母、数字、连字符和下划线，最长 64 字符；同名仓库、目录或回收站中的名称不会被覆盖。文档标题、正文、子目录和简介可使用中文。

直接放入 `obsdian/` 的英文名仓库会被自动识别，无需先在网页注册。`.coral-vault.json` 可保存稳定 ID 和简介；尚无 `obsdian/` 目录时，首次启动会创建 `obsdian/default/`。已有 `obsdian/` 目录时，不会重新创建手动删除的默认仓库。

在磁盘上手动新增、删除或重命名仓库后，点击知识库列表右上角的刷新图标即可重新扫描；手动删除的托管仓库会从列表中移除，不进入 Coral 回收站。配置中注册的外部仓库路径不可访问时，仍显示「暂不可用」，可恢复路径或通过网页删除其注册记录。

## 运行

需要 **Node.js 22.13+** 和 npm，推荐 Node.js 22 或 24 LTS。建议同时安装 Git，供网页写操作保存版本历史。

Windows 下，安装 Node.js 后双击项目根目录的 `run.cmd`，或在 PowerShell 中执行：

```powershell
.\run.cmd
```

脚本会检查 Node.js 版本，在缺少 `sys/node_modules/` 时执行 `npm ci`，然后构建并启动服务；运行期间保留终端窗口，按 `Ctrl+C` 停止。出错时窗口会保留错误信息。更新项目依赖后，可在 `sys/` 中执行 `npm.cmd ci` 重新安装。无需安装 Bash 或 WSL。

Linux / macOS 下，在项目根目录执行：

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

支持 YAML 属性、`[[文件]]`、`[[目录/文件|别名]]`、标题链接、标准 Markdown 相对链接和本地图片。文档页和编辑预览支持以 `mermaid` 标记的代码块，图表渲染器本地打包、按需加载；语法错误时显示提示并保留源码。文档没有固定分类，`index.md`、`log.md` 也是普通文档。跨目录同名文件应使用带目录的引用。

同时支持以 `html` 标记的交互图块，包含的 HTML、CSS、JavaScript、SVG 和 Canvas 在独立沙箱中运行，文档页和编辑预览均可点击交互，高度随内容自动调整。可粘贴 HTML 片段或完整 HTML 文档，例如：

````markdown
```html
<style>button { padding: 12px 20px; border-radius: 8px; }</style>
<button onclick="this.textContent = '已切换状态'">点击交互</button>
```
````

需要只显示 HTML 代码时，将代码块标记写成 `html source`；普通 Markdown 中直接写的 HTML 仍按文本显示。交互图块下方可展开查看源码。完整示例见 [HTML 交互架构图](sys/examples/interactive-html.md)，将示例 Markdown 上传到知识库即可体验。

HTML 图块使用自包含内容，不加载外部脚本、样式、字体或网络数据；图片可使用 data URI，图标可用内联 SVG。脚本不能访问 Coral 页面、登录状态或本地存储，也不能调用 Coral API、提交表单或打开嵌套页面。内容过高时在图块内滚动；使用 `100vh` 或固定高度的图表应自行设置合适的容器高度。此功能不需要模型或新增依赖，也不会在 Obsidian 中执行这些交互脚本。

网页和 MCP 写操作在每个仓库自己的 `.git/` 中留痕，仅提交本次涉及的路径。编辑时校验文档版本，保存前的原文件保留在 `.coral-backups/` 中；备份不参与查询，也不会自动清理。外部程序仍可能再次修改文件，备份用于保留可恢复内容。

目录页、文档页和编辑页显示完整的逐级路径，可点击目录返回。文件夹和文档均可复制 `coral://vault/<id>/<相对路径>` URI。网页列表、详情页和 MCP 支持在原父目录中重命名；文档需保留 `.md` 或 `.markdown` 扩展名。同名或版本冲突时拒绝操作，原始正文、YAML 属性和附件保留。重命名改变文件路径和 URI，不修改 YAML 中的标题，也不自动改写其他笔记中的链接。

删除文件或文件夹会移入所属仓库的 `.trash/`；删除整个托管仓库会移入 `.coral/vault-trash/`。网页回收站支持恢复、彻底删除和清空，恢复遇到同名内容时拒绝覆盖。外部仓库只回收注册记录，不移动或删除原目录。

文件回收站仅管理带有效 `.coral-trash.json` 的 Coral 记录，无法识别的内容会跳过并保留。彻底删除外部仓库注册后，其配置 ID 仍被保留；重新使用该 ID 前需更新配置。

`.coral/` 保存知识库回收状态，不应随意删除。知识仓库、运行状态和本机配置由根目录 `.gitignore` 排除，各仓库独立管理版本历史。

隐藏文件、隐藏目录和符号链接不对外暴露。Markdown 文件上限为 16 MiB，文本读取要求 UTF-8，下载保留原始字节。Obsidian 插件、Canvas、Dataview 和笔记嵌入不在网页执行。

## MCP

支持 Streamable HTTP 和 stdio，两种方式均支持读写。HTTP 客户端连接：

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

MCP 会通过三层说明指导 Agent：连接初始化的 `instructions` 概述工作流与关键限制；`create_document`、`update_document` 及 `content` 参数描述提示写作规则；`get_writing_guide` 工具提供完整指南和可复制示例。对于未展示 MCP resources 的客户端，仍可直接调用该工具，无需访问服务器文件系统。

`get_writing_guide({})` 默认返回完整指南，也可用 `topic` 选择 `workflow`（读写、分页、版本冲突）、`writing`（书写与图表选择）、`links`（链接与附件）、`mermaid`、`html`（交互与沙箱限制）或 `examples`。相同的完整 Markdown 指南通过静态资源 `coral://guide/authoring` 提供，维护源文件为 [Agent 写作与调用指南](sys/docs/agent-writing-guide.md)。指南默认推荐使用 HTML 绘制新图，注重美观、清晰和适当的交互，Mermaid 仍受支持且现有图表默认保留。指南建议写作前查阅，指导尊重用户要求，不会授权额外写操作。

HTTP 服务更新后需要手动重启；stdio 客户端需重启其 MCP 子进程。随后在 Agent 客户端重新连接或刷新工具列表，才会收到新的连接说明与工具定义。客户端是否自动展示和遵循说明取决于其实现，Coral 不会强制执行文风或图表偏好。

| 工具 | 参数 | 返回 |
|---|---|---|
| `get_writing_guide` | 可选 `topic`，默认 `all` | 写作规范、调用流程、链接规则、Mermaid/HTML 限制与完整示例 |
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

`create_document.content` 和 `update_document.content` 均为 Markdown 全文，可包含 YAML 属性。创建时以 `title` 为标题，自动维护创建和更新日期，同名文件使用数字后缀；修改时保持原文件位置，省略 YAML 属性块则保留现有属性。修改大文档前须读取完整的所有分片，避免用局部正文覆盖全文。

修改和删除必须传入最新 `version`：文档版本从 `read_document` 或 `list_documents` 获取，目录版本从 `browse_directory` 获取，知识库版本从 `list_vaults` 获取，恢复所需的回收版本从 `list_trash` 获取。版本冲突会拒绝操作，应重新读取后再修改。MCP 删除均进入回收站；彻底删除和清空回收站仍通过网页执行。

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
