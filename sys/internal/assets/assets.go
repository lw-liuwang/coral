package assets

import (
	"embed"
	"io/fs"
)

//go:embed all:web
var files embed.FS

func Web() fs.FS {
	result, err := fs.Sub(files, "web")
	if err != nil {
		panic(err)
	}
	return result
}
