package coral

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigurationPathsOverridesAndValidation(t *testing.T) {
	root := t.TempDir()
	settings := filepath.Join(root, "settings")
	if err := os.Mkdir(settings, 0755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(settings, "config.yaml")
	put(t, settings, "config.yaml", "data_dir: ../notes\nvaults:\n  project:\n    path: ../project\n")
	t.Setenv("CORAL_DATA_DIR", "")
	t.Setenv("CORAL_HOST", "")
	t.Setenv("CORAL_PORT", "")
	config, err := LoadConfig(file)
	if err != nil {
		t.Fatal(err)
	}
	if config.DataDir != filepath.Join(root, "notes") || config.Vaults["project"].Path != filepath.Join(root, "project") {
		t.Fatal(config)
	}
	t.Setenv("CORAL_DATA_DIR", filepath.Join(root, "override"))
	config, err = LoadConfig(file)
	if err != nil || config.DataDir != filepath.Join(root, "override") {
		t.Fatal(err, config)
	}
	t.Setenv("CORAL_DATA_DIR", "")
	for _, raw := range []string{"data_dir: ''\n", "server:\n  port: 0\n", "search:\n  results_per_page: 101\n", "vaults:\n  default:\n    path: ../project\n", "vaults:\n  external:\n    path: ''\n"} {
		put(t, settings, "config.yaml", raw)
		if _, err := LoadConfig(file); err == nil {
			t.Fatalf("accepted invalid configuration: %s", raw)
		}
	}
	if _, err := LoadConfig(filepath.Join(root, "missing.yaml")); err == nil {
		t.Fatal("accepted missing explicit config")
	}
}

func TestFrontmatterKeepsDateStringsAndEmptyMetadata(t *testing.T) {
	meta, body, err := parseMarkdown("---\ncreated: 2026-11-26\ncustom: [2026-11-25, true, 3]\n---\nBody")
	if err != nil {
		t.Fatal(err)
	}
	if meta["created"] != "2026-11-26" || meta["custom"].([]any)[0] != "2026-11-25" || body != "Body" {
		t.Fatal(meta, body)
	}
	meta, body, err = parseMarkdown("---\n---\nEmpty properties")
	if err != nil || len(meta) != 0 || body != "Empty properties" {
		t.Fatal(err, meta, body)
	}
}
