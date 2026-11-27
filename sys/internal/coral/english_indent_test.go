package coral

import (
	"strings"
	"testing"
)

func TestEnglishParagraphIndentDefaultAndOverride(t *testing.T) {
	body := "# English\n\nFirst paragraph.\n\nSecond paragraph.\n\n- List item\n\n> Quoted paragraph.\n\n![Image](image.png)\n\nFigure 1: Caption."
	for _, tc := range []struct {
		name  string
		meta  map[string]any
		count int
	}{
		{"existing English version", map[string]any{"coral_language": "en"}, 2},
		{"English opt out", map[string]any{"coral_language": "en", "paragraph_indent": "none"}, 0},
		{"Chinese default", map[string]any{"coral_language": "zh"}, 0},
		{"explicit indentation", map[string]any{"paragraph_indent": "2em"}, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rendered, err := RenderMarkdown(body, nil, nil, tc.meta)
			if err != nil {
				t.Fatal(err)
			}
			if count := strings.Count(rendered.HTML, `class="paragraph-indent"`); count != tc.count {
				t.Fatalf("got %d indented paragraphs, want %d: %s", count, tc.count, rendered.HTML)
			}
		})
	}
}

func TestEnglishVersionPersistsDefaultWithoutChangingSourceFormatting(t *testing.T) {
	for _, setting := range []string{"", "none"} {
		t.Run("setting="+setting, func(t *testing.T) {
			r := fixture(t)
			source, err := r.Create("default", "Source", "Chinese paragraph.", map[string]any{"paragraph_indent": "none"}, "", "")
			if err != nil {
				t.Fatal(err)
			}
			content := "# English\n\nEnglish paragraph."
			if setting != "" {
				content = "---\nparagraph_indent: " + setting + "\n---\n" + content
			}
			en, err := r.CreateLanguage(source.URI, "en", content, source.Version, "zh", "English")
			if err != nil {
				t.Fatal(err)
			}
			want := setting
			if want == "" {
				want = "2em"
			}
			if en.Metadata["paragraph_indent"] != want {
				t.Fatalf("got %v, want %s", en.Metadata["paragraph_indent"], want)
			}
			current, err := r.Document(source.URI)
			if err != nil || current.Metadata["paragraph_indent"] != "none" || current.Body != source.Body {
				t.Fatal("source formatting changed", err)
			}
		})
	}
}
