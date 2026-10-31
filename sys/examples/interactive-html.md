# HTML 交互架构图示例

点击模块，查看 Coral 各部分的职责。此图只使用 HTML、CSS 和 JavaScript，无外部依赖。

```html
<style>
  body { padding: 0; background: #f7f9fc; }
  .architecture { padding: 28px; background-image: radial-gradient(#dce3ed 1px, transparent 1px); background-size: 18px 18px; }
  .eyebrow { margin: 0 0 6px; color: #64748b; font-size: 11px; font-weight: 700; letter-spacing: 2px; }
  h2 { margin: 0; color: #17253c; font-size: 24px; letter-spacing: -0.5px; }
  .hint { margin: 6px 0 24px; color: #64748b; font-size: 13px; }
  .modules { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr; align-items: center; gap: 12px; }
  .module { min-width: 0; padding: 18px 12px; text-align: left; border: 1px solid #dce3ed; border-radius: 12px; background: white; cursor: pointer; color: #17253c; transition: border-color .15s, box-shadow .15s; }
  .module:hover { border-color: #94a3b8; }
  .module:focus-visible { outline: 3px solid #93c5fd; outline-offset: 3px; }
  .module[aria-pressed="true"] { border-color: #4769bf; box-shadow: 0 0 0 3px #4769bf16, 0 6px 16px #17253c0a; }
  .number { display: inline-grid; place-items: center; width: 28px; height: 28px; margin-bottom: 12px; border-radius: 8px; background: #edf2ff; color: #4769bf; font-size: 12px; font-weight: 700; }
  .module:nth-of-type(2) .number { background: #fff1eb; color: #b85e40; }
  .module:nth-of-type(3) .number { background: #e7f5f0; color: #2d8067; }
  strong, small { display: block; }
  strong { font-size: 16px; }
  small { margin-top: 4px; color: #64748b; font-size: 12px; }
  .connector { justify-self: center; pointer-events: none; color: #94a3b8; font-size: 20px; }
  .detail { margin-top: 20px; padding: 18px 20px; border: 1px solid #dce3ed; border-radius: 12px; background: #ffffffed; }
  .detail-label { color: #4769bf; font-size: 11px; font-weight: 700; letter-spacing: 1px; }
  #description { min-height: 48px; margin: 8px 0 0; font-size: 14px; color: #475569; }
  @media (max-width: 480px) {
    .architecture { padding: 20px 16px; }
    .modules { grid-template-columns: 1fr; gap: 8px; }
    .module { padding: 12px 16px; }
    .number { float: left; margin: 4px 14px 0 0; }
    .connector { text-align: center; transform: rotate(90deg); line-height: 1; }
  }
</style>
<section class="architecture" aria-label="Coral 交互架构图">
  <p class="eyebrow">CORAL / ARCHITECTURE</p>
  <h2>一份知识，多种入口</h2>
  <p class="hint">选择一个模块，了解它如何协作。</p>
  <div class="modules" role="group" aria-label="架构模块">
    <button class="module" data-module="web" aria-pressed="true"><span class="number">01</span><strong>Web</strong><small>浏览与编辑</small></button>
    <span class="connector" aria-hidden="true">↔</span>
    <button class="module" data-module="vault" aria-pressed="false"><span class="number">02</span><strong>Vault</strong><small>Markdown 文件</small></button>
    <span class="connector" aria-hidden="true">↔</span>
    <button class="module" data-module="mcp" aria-pressed="false"><span class="number">03</span><strong>MCP</strong><small>连接 Agent</small></button>
  </div>
  <div class="detail" aria-live="polite">
    <span class="detail-label">模块职责</span>
    <p id="description">Web 提供知识库浏览、全文搜索与 Markdown 编辑，支持 Mermaid 和 HTML 交互图。</p>
  </div>
</section>
<script>
  const descriptions = {
    web: 'Web 提供知识库浏览、全文搜索与 Markdown 编辑，支持 Mermaid 和 HTML 交互图。',
    vault: 'Vault 将 Markdown 文件作为内容真源。Coral 与 Obsidian 共用这些文件，编辑结果直接保存到磁盘。',
    mcp: 'MCP 为 Agent 提供文档搜索、读取、创建和修改接口，与 Web 共用知识库管理逻辑。'
  };
  document.querySelectorAll('[data-module]').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-module]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      document.querySelector('#description').textContent = descriptions[button.dataset.module];
    });
  });
</script>
```
