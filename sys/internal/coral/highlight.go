package coral

import (
	"bytes"
	"github.com/alecthomas/chroma/v2/formatters/html"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/alecthomas/chroma/v2/styles"
)

var codeFormatter = html.New(html.WithClasses(true), html.ClassPrefix("hljs-"), html.PreventSurroundingPre(true))
var syntaxCSS = func() string {
	var css bytes.Buffer
	if err := codeFormatter.WriteCSS(&css, styles.Get("github")); err != nil {
		panic(err)
	}
	return css.String()
}()

func highlightCode(code, language string) string {
	lexer := lexers.Get(language)
	if lexer == nil {
		return escape(code)
	}
	tokens, err := lexer.Tokenise(nil, code)
	if err != nil {
		return escape(code)
	}
	var result bytes.Buffer
	if err = codeFormatter.Format(&result, styles.Get("github"), tokens); err != nil {
		return escape(code)
	}
	return result.String()
}
