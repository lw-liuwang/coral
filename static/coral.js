// coral — 极少原生 JS：编辑预览防抖、删除确认、运行中自动刷新
(function () {
  "use strict";

  // 编辑页：textarea -> /api/preview 实时预览（500ms 防抖）
  var editor = document.getElementById("editor");
  var preview = document.getElementById("preview");
  if (editor && preview) {
    var timer = null;
    var lastBody = null;
    var render = function () {
      var raw = editor.value;
      // 只把正文部分送预览（跳过 frontmatter）
      var body = raw;
      var m = raw.match(/^---\n[\s\S]*?\n---\n?/);
      if (m) body = raw.slice(m[0].length);
      if (body === lastBody) return;
      lastBody = body;
      fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: body })
      }).then(function (r) { return r.json(); })
        .then(function (d) { preview.innerHTML = d.html || "<p class='muted'>（空）</p>"; })
        .catch(function () { });
    };
    editor.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(render, 500);
    });
    render();

    // textarea 内支持 Tab 缩进
    editor.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        e.preventDefault();
        var s = editor.selectionStart, t = editor.selectionEnd;
        editor.value = editor.value.slice(0, s) + "  " + editor.value.slice(t);
        editor.selectionStart = editor.selectionEnd = s + 2;
      }
    });
  }

  // 删除确认
  window.confirmDelete = function (name) {
    return window.confirm("确定删除 " + name + " ？此操作不可恢复。");
  };
})();
