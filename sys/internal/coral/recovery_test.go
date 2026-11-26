package coral

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestGroupedTrashFailureRecovery(t *testing.T) {
	for _, stage := range []string{"delete", "restore", "external delete"} {
		t.Run(stage, func(t *testing.T) {
			r := fixture(t)
			source := createTest(t, r, "Original", "Chinese", "")
			_, err := r.CreateLanguage(source.URI, "en", "English", source.Version, "zh", "English")
			if err != nil {
				t.Fatal(err)
			}
			family, _ := r.Family(source.URI)
			v, _ := r.Vault("default")
			count := 0
			failSecond := func(phase string) error {
				if phase == "before-transfer" {
					count++
					if count == 2 {
						return fail(500, "second file failure")
					}
				}
				return nil
			}
			if stage == "restore" {
				if err = r.Delete(family.Primary.URI, family.Primary.Version, family.Signature, false); err != nil {
					t.Fatal(err)
				}
				listing, _ := r.ListTrash("default")
				item := listing["items"].([]map[string]any)[0]
				r.testHook = failSecond
				err = r.RestoreTrash("default", stringValue(item["id"]), stringValue(item["version"]), false)
				if err == nil {
					t.Fatal("restore did not fail")
				}
				r.testHook = nil
				listing, err = r.ListTrash("default")
				if err != nil || listing["skipped"] != 0 || len(listing["items"].([]map[string]any)) != 1 {
					t.Fatal(err, listing)
				}
				item = listing["items"].([]map[string]any)[0]
				if err = r.RestoreTrash("default", stringValue(item["id"]), stringValue(item["version"]), false); err != nil {
					t.Fatal(err)
				}
			} else if stage == "delete" {
				r.testHook = failSecond
				err = r.Delete(family.Primary.URI, family.Primary.Version, family.Signature, false)
				if err == nil {
					t.Fatal("delete did not fail")
				}
				r.testHook = nil
				listing, err := r.ListTrash("default")
				if err != nil || listing["skipped"] != 0 || len(listing["items"].([]map[string]any)) != 0 {
					t.Fatal(err, listing)
				}
			} else {
				r.testHook = func(phase string) error {
					if phase == "after-transfers" {
						batches, e := os.ReadDir(filepath.Join(v.Root, ".trash"))
						if e != nil {
							return e
						}
						put(t, filepath.Join(v.Root, ".trash", batches[0].Name()), family.Primary.Relative, "External late edit")
					}
					return nil
				}
				err = r.Delete(family.Primary.URI, family.Primary.Version, family.Signature, false)
				if err == nil {
					t.Fatal("external edit not detected")
				}
				recovery := appError(err).Details["recovery"].(map[string]any)
				if recovery["partial"] != true {
					t.Fatal(recovery)
				}
				listing, err := r.ListTrash("default")
				if err != nil || listing["skipped"] != 0 || len(listing["items"].([]map[string]any)) != 1 {
					t.Fatal(err, listing)
				}
				item := listing["items"].([]map[string]any)[0]
				r.testHook = nil
				if err = r.RestoreTrash("default", stringValue(item["id"]), stringValue(item["version"]), false); err != nil {
					t.Fatal(err)
				}
				if readTest(t, v.Root, family.Primary.Relative) != "External late edit" {
					t.Fatal("lost external edit")
				}
				return
			}
			for _, member := range family.Versions {
				if !exists(filepath.Join(v.Root, filepath.FromSlash(member.Relative))) {
					t.Fatal("lost language file", member.URI)
				}
			}
		})
	}
}
func TestRelocationProtectsRegisteredRootsAndHiddenExternalAdditions(t *testing.T) {
	r := fixture(t)
	v, _ := r.Vault("default")
	put(t, v.Root, "docs/nested/note.md", "# Note")
	r.Config.Vaults["nested"] = VaultConfig{Path: filepath.Join(v.Root, "docs/nested")}
	entry, _ := r.Entry(ResourceURI("default", "docs"))
	if _, err := r.Relocate(entry.URI, "renamed", entry.Version, "", true); err == nil {
		t.Fatal("moved registered Vault")
	}
	delete(r.Config.Vaults, "nested")
	put(t, v.Root, "source.md", "[note](docs/nested/note.md)")
	entry, _ = r.Entry(entry.URI)
	r.testHook = func(phase string) error {
		if phase == "before-replace" {
			put(t, v.Root, "renamed/.external", "Concurrent addition")
			return fail(500, "write failed")
		}
		return nil
	}
	_, err := r.Relocate(entry.URI, "renamed", entry.Version, "", true)
	if err == nil {
		t.Fatal("write failure not reported")
	}
	if !exists(filepath.Join(v.Root, "renamed/.external")) {
		t.Fatal("lost concurrent addition")
	}
	if appError(err).Details["recovery"].(map[string]any)["partial"] != true {
		t.Fatal(err)
	}
}
func TestOrdinaryDocumentWithEncodedPunctuationURI(t *testing.T) {
	r := fixture(t)
	d := createTest(t, r, "Punctuation !'()", "# Body", "")
	if !strings.Contains(d.URI, "!'()") {
		t.Fatal(d.URI)
	}
	encoded := strings.ReplaceAll(d.URI, "!", "%21")
	read, err := r.Read(encoded, ReadOptions{})
	if err != nil || read["uri"] != d.URI {
		t.Fatal(err, read)
	}
}

func TestEnglishVersionRenameUsesPrimaryNameAndExtension(t *testing.T) {
	r := fixture(t)
	source := createTest(t, r, "Original", "Chinese", "")
	english, err := r.CreateLanguage(source.URI, "en", "English", source.Version, "zh", "English")
	if err != nil {
		t.Fatal(err)
	}
	family, err := r.Family(english.URI)
	if err != nil {
		t.Fatal(err)
	}
	renamed, err := r.Rename(english.URI, "Renamed.markdown", english.Version, family.Signature, false)
	if err != nil {
		t.Fatal(err)
	}
	family, err = r.Family(renamed.URI)
	if err != nil {
		t.Fatal(err)
	}
	if family.Primary.Relative != "Renamed.markdown" || renamed.Relative != "Renamed.en.markdown" {
		t.Fatal(family, renamed)
	}
}

func TestCaseOnlyRenamePreservesBytes(t *testing.T) {
	r := fixture(t)
	d := createTest(t, r, "Original", "Keep bytes", "")
	renamed, err := r.Rename(d.URI, "original.md", d.Version, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Relative != "original.md" || renamed.Document.Raw != d.Raw {
		t.Fatal(renamed)
	}
}

func TestWikiImagesPreferLiteralPercentNames(t *testing.T) {
	r := fixture(t)
	v, _ := r.Vault("default")
	put(t, v.Root, "assets/a%20b.png", "literal")
	put(t, v.Root, "assets/a b.png", "space")
	d := createTest(t, r, "Images", "", "")
	rendered, err := RenderMarkdown("![[assets/a%20b.png|300]] ![space](assets/a%20b.png)", nil, &d, nil)
	if err != nil {
		t.Fatal(err)
	}
	images := regexp.MustCompile(`src="([^"]+)"`).FindAllStringSubmatch(rendered.HTML, -1)
	if len(images) != 2 {
		t.Fatal(rendered.HTML)
	}
	for i, image := range images {
		u, err := url.Parse(image[1])
		if err != nil {
			t.Fatal(err)
		}
		bytes, _, err := r.Asset(u.Query().Get("uri"))
		if err != nil {
			t.Fatal(err)
		}
		want := []string{"literal", "space"}[i]
		if string(bytes) != want {
			t.Fatal(string(bytes), want)
		}
	}
}
