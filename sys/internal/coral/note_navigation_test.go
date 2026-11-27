package coral

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReadingNoteNavigationUsesLogicalSiblings(t *testing.T) {
	app, err := NewApp(DefaultConfig(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	v, _ := app.Registry.Vault("default")
	for _, name := range []string{"100.md", "11.md", "10.md", "9.md", "index.md"} {
		put(t, v.Root, "课程 空格/"+name, "---\ntitle: Note "+name+"\n---\n# Note\n\n## Chapter\n\nContent")
	}
	put(t, v.Root, "课程 空格/子目录/hidden.md", "Descendant")
	id := "00000000-0000-4000-8000-000000000001"
	put(t, v.Root, "课程 空格/10.md", "---\ntitle: 中文标题\ncoral_note_id: "+id+"\ncoral_language: zh\ncoral_primary: true\n---\n# 中文标题\n\n## 章节\n\n中文")
	put(t, v.Root, "课程 空格/10.en.md", "---\ntitle: English\ncoral_note_id: "+id+"\ncoral_language: en\ncoral_primary: false\n---\n# English\n\n## Chapter\n\nEnglish")
	uri := ResourceURI("default", "课程 空格/10.en.md")
	request := httptest.NewRequest("GET", withReturn(viewURL(uri), "/search?q=KV&vault=default&cursor=20#doc-result"), nil)
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	body := response.Body.String()
	start := strings.Index(body, `<aside class="reading-notes"`)
	if start < 0 {
		t.Fatal("note rail missing")
	}
	end := strings.Index(body[start:], `</aside>`) + start
	if end < start {
		t.Fatal("note rail missing")
	}
	rail := body[start:end]
	if strings.Count(rail, "<li>") != 5 || strings.Contains(rail, "10.en.md") || strings.Contains(rail, "Descendant") {
		t.Fatal(rail)
	}
	last := -1
	for _, title := range []string{"Note index.md", "Note 9.md", "中文标题", "Note 11.md", "Note 100.md"} {
		next := strings.Index(rail, `<span>`+title+`</span>`)
		if next <= last {
			t.Fatal("note order changed", rail)
		}
		last = next
	}
	if !strings.Contains(rail, `title="10.md" aria-current="page"`) || strings.Count(rail, `aria-current=`) != 1 {
		t.Fatal("English did not select its primary", rail)
	}
	if !strings.Contains(rail, "return_to=") || !strings.Contains(rail, "cursor%3D20") {
		t.Fatal("search context lost", rail)
	}
	if start < strings.Index(body, `<aside class="sidebar"`) || strings.Index(body, `<aside class="reading-outline"`) < end {
		t.Fatal("navigation order changed")
	}
}

func TestNoteNavigationIsReadingOnlyAndHandlesNotesWithoutChapters(t *testing.T) {
	app, err := NewApp(DefaultConfig(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	d := createTest(t, app.Registry, "Standalone", "A paragraph without headings.", "")
	for _, tc := range []struct {
		url     string
		reading bool
	}{{viewURL(d.URI), true}, {editURL(d.URI), false}, {"/?vault=default", false}, {"/search?q=Standalone", false}} {
		response := httptest.NewRecorder()
		app.ServeHTTP(response, httptest.NewRequest("GET", tc.url, nil))
		if response.Code != 200 {
			t.Fatal(tc.url, response.Body.String())
		}
		body := response.Body.String()
		if strings.Contains(body, `aria-label="笔记导航"`) != tc.reading {
			t.Fatal("note rail on wrong page", tc.url)
		}
		if tc.reading && !strings.Contains(body, `title="Standalone.md" aria-current="page"`) {
			t.Fatal("reading navigation missing")
		}
		if strings.Contains(body, `aria-label="文章导航"`) != tc.reading || strings.Contains(body, `data-drawer-toggle="chapters"`) != tc.reading {
			t.Fatal("reading pages must keep the chapter column even without headings", tc.url)
		}
	}
}
