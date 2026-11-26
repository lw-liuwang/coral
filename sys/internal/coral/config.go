package coral

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"gopkg.in/yaml.v3"
)

const Version = "0.3.0"

type Config struct {
	Server struct {
		Host string `yaml:"host" json:"host"`
		Port int    `yaml:"port" json:"port"`
	} `yaml:"server" json:"server"`
	DataDir string                 `yaml:"data_dir" json:"data_dir"`
	Vaults  map[string]VaultConfig `yaml:"vaults" json:"vaults"`
	Search  struct {
		ResultsPerPage int `yaml:"results_per_page" json:"results_per_page"`
	} `yaml:"search" json:"search"`
}
type VaultConfig struct {
	Name        string `yaml:"name" json:"name"`
	Description string `yaml:"description" json:"description"`
	Path        string `yaml:"path" json:"path"`
}

func DefaultConfig(base string) Config {
	c := Config{DataDir: filepath.Clean(base), Vaults: map[string]VaultConfig{}}
	c.Server.Host, c.Server.Port, c.Search.ResultsPerPage = "127.0.0.1", 8300, 20
	return c
}

func LoadConfig(filename string) (Config, error) {
	if filename == "" {
		filename = os.Getenv("CORAL_CONFIG")
	}
	explicit := filename != ""
	if filename == "" {
		exe, err := os.Executable()
		if err != nil {
			return Config{}, err
		}
		filename = filepath.Join(filepath.Dir(exe), "config.yaml")
		if filepath.Base(filepath.Dir(exe)) == "dist" {
			source := filepath.Dir(filepath.Dir(exe))
			if _, err := os.Stat(filepath.Join(source, "go.mod")); err == nil {
				filename = filepath.Join(source, "config.yaml")
			}
		}
		// Source checkouts keep configuration under sys/ and data one level above.
		if _, err := os.Stat("go.mod"); err == nil {
			filename = "config.yaml"
		}
	}
	filename, err := filepath.Abs(filename)
	if err != nil {
		return Config{}, err
	}
	c := DefaultConfig(filepath.Join(filepath.Dir(filename), ".."))
	if !explicit {
		if _, e := os.Stat(filepath.Join(filepath.Dir(filename), "go.mod")); e != nil {
			c.DataDir = filepath.Dir(filename)
		}
	}
	raw, err := os.ReadFile(filename)
	if err != nil && (explicit || !os.IsNotExist(err)) {
		return c, err
	}
	if len(raw) > 0 {
		if err := yaml.Unmarshal(raw, &c); err != nil {
			return c, fmt.Errorf("invalid configuration: %w", err)
		}
	}
	base := filepath.Dir(filename)
	if c.DataDir == "" {
		return c, fmt.Errorf("invalid data_dir: expected a nonempty path")
	}
	if !filepath.IsAbs(c.DataDir) {
		c.DataDir = filepath.Join(base, c.DataDir)
	}
	for id, v := range c.Vaults {
		if !validID.MatchString(id) || id == "default" || v.Path == "" {
			return c, fmt.Errorf("invalid Vault configuration: %s", id)
		}
		if !filepath.IsAbs(v.Path) {
			v.Path = filepath.Join(base, v.Path)
		}
		c.Vaults[id] = v
	}
	if value := os.Getenv("CORAL_DATA_DIR"); value != "" {
		c.DataDir, err = filepath.Abs(value)
		if err != nil {
			return c, err
		}
	}
	if value := os.Getenv("CORAL_HOST"); value != "" {
		c.Server.Host = value
	}
	if value := os.Getenv("CORAL_PORT"); value != "" {
		c.Server.Port, err = strconv.Atoi(value)
		if err != nil {
			return c, fmt.Errorf("invalid CORAL_PORT")
		}
	}
	if c.Server.Host == "" || c.Server.Port < 1 || c.Server.Port > 65535 || c.Search.ResultsPerPage < 1 || c.Search.ResultsPerPage > 100 {
		return c, fmt.Errorf("invalid server or search configuration")
	}
	return c, nil
}

var validID = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
var validVaultName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type AppError struct {
	Message string
	Status  int
	Details map[string]any
}

func (e *AppError) Error() string           { return e.Message }
func fail(status int, message string) error { return &AppError{Message: message, Status: status} }
func jsonBytes(value any) []byte            { data, _ := json.Marshal(value); return data }
