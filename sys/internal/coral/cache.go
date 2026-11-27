package coral

import (
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
)

// Cached documents and inventories are immutable after publication. Request
// scopes share these caches, but never share their request-local inventory map.
type registryCache struct {
	gate         sync.RWMutex
	mu           sync.Mutex
	vaults       map[string]*vaultCache
	fingerprints map[string]cachedFingerprint
}
type vaultCache struct {
	mu        sync.Mutex
	documents map[string]Document
	files     map[string]scannedFile
	scan      Scan
}
type scannedFile struct {
	stamp    fileStamp
	document Document
}
type fileStamp struct {
	Size, Modified, Changed int64
	Device, Identity        uint64
	Mode                    os.FileMode
}
type cachedFingerprint struct {
	stamp fileStamp
	hash  string
}
type documentIndex struct {
	searchOnce, linksOnce sync.Once
	title, body           []searchToken
	links                 []string
}

func (d Document) searchIndex() *documentIndex {
	i := d.index
	if i == nil {
		i = &documentIndex{}
	}
	i.searchOnce.Do(func() {
		i.title = searchTokens(d.Title + "\n" + d.Relative)
		i.body = searchTokens(d.Body)
	})
	return i
}
func (d Document) outgoingLinks() []string {
	i := d.index
	if i == nil {
		i = &documentIndex{}
	}
	i.linksOnce.Do(func() {
		if strings.Contains(d.Body, "[[") {
			i.links = wikiTargets(d.Body)
		}
	})
	return i.links
}

type vaultIndex struct {
	groups        map[string]Family
	notes         []Document
	links         *linkIndex
	backlinksOnce sync.Once
	backlinks     map[string][]Document
	documents     []Document
}

func newVaultIndex(documents []Document) *vaultIndex {
	i := &vaultIndex{groups: groupNotes(documents), links: newLinkIndex(documents), documents: documents}
	for _, d := range documents {
		f := i.groups[d.URI]
		if f.Primary.URI == d.URI {
			i.notes = append(i.notes, withLanguages(f.Primary, f))
		}
	}
	return i
}
func (i *vaultIndex) linkedFrom(uri string) []Document {
	i.backlinksOnce.Do(func() {
		i.backlinks = map[string][]Document{}
		for _, d := range i.documents {
			seen := map[string]bool{}
			for _, target := range d.outgoingLinks() {
				if resolved := i.links.resolve(target, &d, false); resolved != nil && !seen[resolved.URI] {
					i.backlinks[resolved.URI] = append(i.backlinks[resolved.URI], d)
					seen[resolved.URI] = true
				}
			}
		}
	})
	return i.backlinks[uri]
}
func (r *Registry) scoped(readOnly bool) *Registry {
	s := &Registry{Config: r.Config, cache: r.cache, testHook: r.testHook}
	if readOnly {
		s.requestScans = map[string]Scan{}
	}
	return s
}
func (r *Registry) vaultCache(v Vault) *vaultCache {
	key := v.ID + ":" + filepath.Clean(v.Root)
	r.cache.mu.Lock()
	defer r.cache.mu.Unlock()
	c := r.cache.vaults[key]
	if c == nil {
		c = &vaultCache{documents: map[string]Document{}, files: map[string]scannedFile{}}
		r.cache.vaults[key] = c
	}
	return c
}
func sameInventory(a, b Scan) bool {
	if a.index == nil || a.Skipped != b.Skipped || len(a.Documents) != len(b.Documents) || len(a.directories) != len(b.directories) {
		return false
	}
	for n, d := range a.Documents {
		if d.URI != b.Documents[n].URI || d.Version != b.Documents[n].Version {
			return false
		}
	}
	for n, d := range a.directories {
		if d != b.directories[n] {
			return false
		}
	}
	return true
}

func (r *Registry) cachedFingerprint(filename string) (string, error) {
	info, err := os.Lstat(filename)
	if err != nil {
		return "", err
	}
	stamp, err := statStamp(filename, info)
	if err != nil {
		return "", err
	}
	r.cache.mu.Lock()
	previous, ok := r.cache.fingerprints[filename]
	r.cache.mu.Unlock()
	if ok && previous.stamp == stamp {
		return previous.hash, nil
	}
	hash, err := fileDigest(filename)
	if err != nil {
		return "", err
	}
	r.cache.mu.Lock()
	if len(r.cache.fingerprints) >= 16384 {
		clear(r.cache.fingerprints)
	}
	r.cache.fingerprints[filename] = cachedFingerprint{stamp: stamp, hash: hash}
	r.cache.mu.Unlock()
	return hash, nil
}

type linkIndex struct {
	paths map[string]*Document
	names map[string][]*Document
}

func newLinkIndex(documents []Document) *linkIndex {
	i := &linkIndex{paths: map[string]*Document{}, names: map[string][]*Document{}}
	for n := range documents {
		d := &documents[n]
		base := stripExtension(d.Relative)
		if i.paths[base] == nil {
			i.paths[base] = d
		}
		parts := strings.Split(base, "/")
		names := map[string]bool{}
		for n := range parts {
			names[strings.Join(parts[n:], "/")] = true
		}
		if aliases, ok := d.Metadata["aliases"].([]any); ok {
			for _, alias := range aliases {
				if s, ok := alias.(string); ok {
					names[s] = true
				}
			}
		}
		for name := range names {
			i.names[name] = append(i.names[name], d)
		}
	}
	return i
}
func (i *linkIndex) resolve(target string, current *Document, relative bool) *Document {
	candidates := decodeCandidates(strings.SplitN(target, "#", 2)[0])
	if relative && len(candidates) > 1 {
		candidates[0], candidates[1] = candidates[1], candidates[0]
	}
	for _, candidate := range candidates {
		base := stripExtension(candidate)
		if base == "" && current != nil {
			return current
		}
		local := ""
		if current != nil {
			local = stripExtension(path.Clean(path.Join(parent(current.Relative), base)))
		}
		if relative {
			if d := i.paths[local]; d != nil {
				return d
			}
			continue
		}
		if d := i.paths[base]; d != nil {
			return d
		}
		if d := i.paths[local]; d != nil {
			return d
		}
		if matches := i.names[base]; len(matches) == 1 {
			return matches[0]
		} else if len(matches) > 1 {
			return nil
		}
	}
	return nil
}
