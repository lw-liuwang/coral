package coral

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func listedVaultVersion(t *testing.T, r *Registry, id string) string {
	t.Helper()
	listing, err := r.ListVaults()
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range listing["vaults"].([]any) {
		v := item.(map[string]any)
		if v["id"] == id {
			return stringValue(v["version"])
		}
	}
	t.Fatalf("vault %s missing from listing", id)
	return ""
}

func TestUXNamedVaultPersistsAndRestores(t *testing.T) {
	r := fixture(t)
	v, err := r.CreateNamedVault("学习笔记", "研究记录")
	if err != nil {
		t.Fatal(err)
	}
	if v.Name != "学习笔记" || !validVaultName.MatchString(v.ID) || filepath.Base(v.Root) != v.ID {
		t.Fatalf("invalid named vault: %#v", v)
	}
	d, err := r.Create(v.ID, "研究", "可检索的内容", nil, "", "")
	if err != nil {
		t.Fatal(err)
	}
	r, err = NewRegistry(r.Config)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := r.Vault(v.ID)
	if err != nil || loaded != v {
		t.Fatalf("restart changed vault: %#v %v", loaded, err)
	}
	found, err := r.Search("可检索", v.ID, 20, 0)
	if err != nil || found["total"] != 1 {
		t.Fatal(found, err)
	}
	receipt, err := r.DeleteVaultWithReceipt(v.ID, listedVaultVersion(t, r, v.ID))
	if err != nil || receipt.Scope != "vault" || receipt.VaultID != v.ID || receipt.EntryID != "" || receipt.Version == "" {
		t.Fatalf("invalid vault receipt: %#v %v", receipt, err)
	}
	r, err = NewRegistry(r.Config)
	if err != nil {
		t.Fatal(err)
	}
	if err = r.RestoreVault(receipt.VaultID, receipt.Version, false); err != nil {
		t.Fatal(err)
	}
	loaded, err = r.Vault(v.ID)
	if err != nil || loaded != v {
		t.Fatalf("restore changed vault: %#v %v", loaded, err)
	}
	if restored, err := r.Document(d.URI); err != nil || restored.Body != d.Body {
		t.Fatal("restore changed content or URI", restored, err)
	}
}

func TestUXVaultDisplayNameDoesNotChooseRestoreDirectory(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(map[bool]string{false: "directory field", true: "legacy root"}[legacy], func(t *testing.T) {
			r := fixture(t)
			v, err := r.CreateVaultWithDisplayName("research", "", "Reading")
			if err != nil {
				t.Fatal(err)
			}
			put(t, v.Root, "note.md", "Original content")
			receipt, err := r.DeleteVaultWithReceipt(v.ID, listedVaultVersion(t, r, v.ID))
			if err != nil {
				t.Fatal(err)
			}
			if legacy {
				dir, _ := r.stateDir(v.ID)
				var record map[string]any
				if err = readJSON(filepath.Join(dir, "state.json"), &record); err != nil {
					t.Fatal(err)
				}
				delete(record, "directory")
				if err = saveJSON(filepath.Join(dir, "state.json"), record); err != nil {
					t.Fatal(err)
				}
				listing, err := r.ListTrash("")
				if err != nil {
					t.Fatal(err)
				}
				receipt.Version = stringValue(listing["vaults"].([]map[string]any)[0]["version"])
			}
			if err = r.RestoreVault(receipt.VaultID, receipt.Version, false); err != nil {
				t.Fatal(err)
			}
			loaded, err := r.Vault(v.ID)
			if err != nil || loaded.Root != v.Root || loaded.Name != "Reading" || exists(filepath.Join(r.Config.DataDir, "obsdian", "reading")) {
				t.Fatalf("display name changed restore directory: %#v %v", loaded, err)
			}
			if readTest(t, loaded.Root, "note.md") != "Original content" {
				t.Fatal("restore lost vault content")
			}
		})
	}
}

func TestUXLegacyVaultIDsAndMCPNamesRemainCompatible(t *testing.T) {
	r := fixture(t)
	root := filepath.Join(r.Config.DataDir, "obsdian", "archive")
	put(t, root, ".coral-vault.json", `{"id":"stable-id","description":"Legacy manifest"}`)
	legacy, err := r.Vault("stable-id")
	if err != nil || legacy.Name != "archive" {
		t.Fatal(legacy, err)
	}
	receipt, err := r.DeleteVaultWithReceipt("stable-id", listedVaultVersion(t, r, "stable-id"))
	if err != nil {
		t.Fatal(err)
	}
	if err = r.RestoreVault(receipt.VaultID, receipt.Version, false); err != nil {
		t.Fatal(err)
	}
	legacy, err = r.Vault("stable-id")
	if err != nil || legacy.Root != root || legacy.Name != "archive" {
		t.Fatal(legacy, err)
	}
	receipt, err = r.DeleteVaultWithReceipt("default", listedVaultVersion(t, r, "default"))
	if err != nil {
		t.Fatal(err)
	}
	if err = r.RestoreVault(receipt.VaultID, receipt.Version, false); err != nil {
		t.Fatal(err)
	}
	if v, err := r.Vault("default"); err != nil || filepath.Base(v.Root) != "default" {
		t.Fatal(v, err)
	}
	plain, err := r.callTool("create_vault", map[string]any{"name": "MyNotes", "description": "Original call"})
	if err != nil || plain["vault_id"] != "mynotes" || plain["name"] != "mynotes" {
		t.Fatal(plain, err)
	}
	named, err := r.callTool("create_vault", map[string]any{"name": "team", "display_name": "团队知识库"})
	if err != nil || named["vault_id"] != "team" || named["name"] != "团队知识库" {
		t.Fatal(named, err)
	}
	if _, err = r.callTool("create_vault", map[string]any{"name": "团队"}); err == nil {
		t.Fatal("MCP unexpectedly changed its ASCII ID contract")
	}
}

func TestUXNamedVaultValidatesDisplayNamesBeforeCreating(t *testing.T) {
	r := fixture(t)
	for _, name := range []string{"", "  ", "first\nsecond", strings.Repeat("界", 201)} {
		if _, err := r.CreateNamedVault(name, ""); err == nil {
			t.Errorf("accepted invalid display name %q", name)
		}
	}
	vs, err := r.Vaults()
	if err != nil || len(vs) != 1 || vs[0].ID != "default" {
		t.Fatal("invalid name created a vault", vs, err)
	}
}

func TestUXTrashReceiptsRestoreTheExactBilingualBatch(t *testing.T) {
	r := fixture(t)
	source := createTest(t, r, "Note", "Original Chinese", "")
	if _, err := r.CreateLanguage(source.URI, "en", "Original English", source.Version, "zh", "English"); err != nil {
		t.Fatal(err)
	}
	family, err := r.Family(source.URI)
	if err != nil {
		t.Fatal(err)
	}
	first, err := r.DeleteWithReceipt(family.Primary.URI, family.Primary.Version, family.Signature, false)
	if err != nil || first.Scope != "item" || first.VaultID != "default" || first.EntryID == "" || first.Version == "" {
		t.Fatal(first, err)
	}
	replacement := createTest(t, r, "Note", "Second deletion", "")
	second, err := r.DeleteWithReceipt(replacement.URI, replacement.Version, "", false)
	if err != nil || second.EntryID == first.EntryID {
		t.Fatal(second, err)
	}
	if err = r.RestoreTrash(first.VaultID, first.EntryID, first.Version, false); err != nil {
		t.Fatal(err)
	}
	for _, d := range family.Versions {
		got, err := r.Document(d.URI)
		if err != nil || got.Raw != d.Raw {
			t.Fatalf("receipt restored wrong batch: %#v %v", got, err)
		}
	}
	if err = r.RestoreTrash(second.VaultID, second.EntryID, second.Version, false); err == nil {
		t.Fatal("restoration overwrote the first batch")
	}
	if got, err := r.Document(family.Primary.URI); err != nil || got.Body != family.Primary.Body {
		t.Fatal("conflict changed restored content", got, err)
	}
}

func TestUXDirectoryReceiptPreservesAttachmentsAndConflicts(t *testing.T) {
	r := fixture(t)
	v, _ := r.Vault("default")
	put(t, v.Root, "nested/child/note.md", "Nested note")
	put(t, v.Root, "nested/assets/picture.txt", "Attachment bytes")
	uri := ResourceURI(v.ID, "nested")
	entry, err := r.Entry(uri)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := r.DeleteWithReceipt(uri, entry.Version, "", true)
	if err != nil {
		t.Fatal(err)
	}
	put(t, v.Root, "nested/new.md", "New content")
	if err = r.RestoreTrash(receipt.VaultID, receipt.EntryID, receipt.Version, false); err == nil {
		t.Fatal("restore overwrote recreated directory")
	}
	if readTest(t, v.Root, "nested/new.md") != "New content" {
		t.Fatal("conflict changed new content")
	}
	if err = os.Remove(filepath.Join(v.Root, "nested", "new.md")); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(v.Root, "nested")); err != nil {
		t.Fatal(err)
	}
	if err = r.RestoreTrash(receipt.VaultID, receipt.EntryID, receipt.Version, false); err != nil {
		t.Fatal(err)
	}
	if readTest(t, v.Root, "nested/child/note.md") != "Nested note" || readTest(t, v.Root, "nested/assets/picture.txt") != "Attachment bytes" {
		t.Fatal("directory restoration lost files")
	}
}
