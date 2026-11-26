package coral

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRelocationSourceCases(t *testing.T) {
	cases := []struct{ name, source, want string }{
		{"inline and reference", `[inline](docs/note.md#part "Title")` + "\n[ref][n]\n\n[n]: <docs/note.md#part> \"Title\"", `[inline](new%20docs/note.md#part "Title")` + "\n[ref][n]\n\n[n]: <new%20docs/note.md#part> \"Title\""},
		{"nested image label", `[![Alt](docs/assets/pixel.png)](docs/note.md#part\!)`, `[![Alt](new%20docs/assets/pixel.png)](new%20docs/note.md#part\!)`},
		{"quoted list references", "> [quoted](docs/note.md)\n\n- [list](docs/note.md)\n\n![ref][image]\n\n[image]: docs/assets/pixel.png \"Image\"", "> [quoted](new%20docs/note.md)\n\n- [list](new%20docs/note.md)\n\n![ref][image]\n\n[image]: new%20docs/assets/pixel.png \"Image\""},
		{"protected frontmatter", "---\nreference: docs/note.md\n---\n[normal](docs/note.md)\n```md\n[code](docs/note.md)\n```\n", "---\nreference: docs/note.md\n---\n[normal](new%20docs/note.md)\n```md\n[code](docs/note.md)\n```\n"},
		{"nested inline HTML", `<em><em>nested</em>[inline HTML](docs/note.md)</em>` + "\n\n    [indented code](docs/note.md)\n", `<em><em>nested</em>[inline HTML](docs/note.md)</em>` + "\n\n    [indented code](docs/note.md)\n"},
		{"coral autolink", `<coral://vault/default/docs/note.md>`, `<coral://vault/default/new%20docs/note.md>`},
		{"wiki and images", `[[docs/note#part|Shown]] ![[docs/assets/pixel.png|480]] [folder](coral://vault/default/docs)`, `[[new docs/note#part|Shown]] ![[new docs/assets/pixel.png|480]] [folder](coral://vault/default/new%20docs)`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := fixture(t)
			v, _ := r.Vault("default")
			put(t, v.Root, "docs/note.md", "# Note")
			put(t, v.Root, "docs/assets/pixel.png", "pixel")
			put(t, v.Root, "source.md", c.source)
			entry, err := r.Entry(ResourceURI("default", "docs"))
			if err != nil {
				t.Fatal(err)
			}
			_, err = r.Relocate(entry.URI, "new docs", entry.Version, "", true)
			if err != nil {
				t.Fatal(err)
			}
			if got := readTest(t, v.Root, "source.md"); got != c.want {
				t.Fatalf("wanted %q\ngot    %q", c.want, got)
			}
		})
	}
}
func TestRelocationAmbiguityAndUnlocatableReferences(t *testing.T) {
	for _, scenario := range []string{"short name", "encoded collision", "unlocated reference"} {
		t.Run(scenario, func(t *testing.T) {
			r := fixture(t)
			v, _ := r.Vault("default")
			put(t, v.Root, "docs/old.md", "---\naliases: [stable]\n---\n# Original")
			put(t, v.Root, "archive/new.md", "# Existing")
			source := "[[old]] [[new]] [[stable]] [[missing]]"
			destination := "docs/new.md"
			want := "[[docs/new]] [[archive/new]] [[stable]] [[missing]]"
			if scenario == "encoded collision" {
				put(t, v.Root, "docs/name%23part.md", "# Literal")
				source = "[[docs/old]]"
				destination = "docs/name#part.md"
			}
			if scenario == "unlocated reference" {
				source = "> [note][n]\n>\n> [n]:\n>   docs/old.md\n"
				destination = "archive/old.md"
			}
			put(t, v.Root, "source.md", source)
			d, _ := r.Document(ResourceURI("default", "docs/old.md"))
			_, err := r.Relocate(d.URI, destination, d.Version, "", true)
			if scenario == "short name" {
				if err != nil {
					t.Fatal(err)
				}
				if got := readTest(t, v.Root, "source.md"); got != want {
					t.Fatal(got)
				}
			} else {
				if err == nil {
					t.Fatal("unsafe reference accepted")
				}
				if !exists(filepath.Join(v.Root, "docs/old.md")) || readTest(t, v.Root, "source.md") != source {
					t.Fatal("failed precheck mutated files")
				}
			}
		})
	}
}
func TestNativeSearchTokenCompatibility(t *testing.T) {
	cases := []struct {
		body, query string
		want        bool
	}{{"数据库位于开头，经过一段文字以后才讲优化。", "数据库 优化", true}, {"数据库位于开头，经过一段文字以后才讲优化。", "数据库优化", false}, {"数**据**库支持索引。", "数据库", true}, {"数abc据库支持索引。", "数据库", false}, {"Layer,\n**Norm** handles Café.", "layer-norm cafe", true}, {"o\u0323\u0302 Café", "o cafe", true}, {"ſample", "sample", true}, {"ǣ", "æ", false}, {"ộ", "o", false}, {"Αθήνα", "Αθηνα", false}, {"ガ", "カ", false}, {"गोदाम", "गदाम", false}, {"Layer Norm.", `title:("norm") OR *`, false}, {"Layer Norm.", `"`, false}}
	for _, c := range cases {
		if got := matches(c.body, strings.Fields(c.query)); got != c.want {
			t.Errorf("%q / %q: %v", c.body, c.query, got)
		}
	}
}
func TestNativePathAndSizeLimits(t *testing.T) {
	r := fixture(t)
	v, _ := r.Vault("default")
	put(t, v.Root, ".hidden.md", "Hidden")
	put(t, v.Root, ".private/note.md", "Private")
	large := filepath.Join(v.Root, "large.md")
	f, err := os.Create(large)
	if err != nil {
		t.Fatal(err)
	}
	err = f.Truncate(MaxFileBytes + 1)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{".hidden.md", ".private/note.md", "large.md"} {
		if _, err := r.Document(ResourceURI("default", rel)); err == nil {
			t.Errorf("read %s", rel)
		}
	}
	outside := t.TempDir()
	put(t, outside, "note.md", "Outside")
	link := filepath.Join(v.Root, "linked")
	if err := os.Symlink(outside, link); err != nil {
		t.Logf("directory symlinks unavailable: %v", err)
	} else {
		if _, err := r.Document(ResourceURI("default", "linked/note.md")); err == nil {
			t.Fatal("followed symlink")
		}
	}
	scan, err := r.Scan("default")
	if err != nil {
		t.Fatal(err)
	}
	if len(scan.Documents) != 0 || scan.Skipped != 1 {
		t.Fatal(scan)
	}
}
