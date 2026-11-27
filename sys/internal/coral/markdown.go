package coral

import (
	"bytes"
	"fmt"
	"html"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extast "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

func escape(s string) string    { return html.EscapeString(s) }
func viewURL(uri string) string { return "/document?uri=" + encodeURI(uri) }
func editURL(uri string) string { return "/edit?uri=" + encodeURI(uri) }
func headingID(title string) string {
	var b strings.Builder
	space := false
	for _, c := range strings.ToLower(strings.TrimSpace(title)) {
		if unicode.IsSpace(c) {
			space = true
			continue
		}
		if unicode.IsLetter(c) || unicode.IsDigit(c) || c == '_' || c == '-' {
			if space && b.Len() > 0 {
				b.WriteByte('-')
			}
			space = false
			b.WriteRune(c)
		}
	}
	if b.Len() == 0 {
		return "section"
	}
	return b.String()
}
func decodeCandidates(s string) []string {
	out := []string{s}
	if decoded, e := url.PathUnescape(s); e == nil && decoded != s {
		out = append(out, decoded)
	}
	return out
}
func stripExtension(s string) string {
	if isMarkdown(s) {
		return strings.TrimSuffix(s, path.Ext(s))
	}
	return s
}

type RenderedHeading struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Level int    `json:"level"`
}
type RenderedMarkdown struct {
	HTML        string
	Headings    []RenderedHeading
	WikiTargets []string
}

var kindCoralInline = ast.NewNodeKind("CoralInline")

type coralInline struct {
	ast.BaseInline
	KindName, Value, Label string
}

func (n *coralInline) Kind() ast.NodeKind { return kindCoralInline }
func (n *coralInline) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, map[string]string{"value": n.Value}, nil)
}

type inlineParser struct{}

func (p *inlineParser) Trigger() []byte { return []byte{'[', '!', '$', '\\'} }

var wikiPattern = regexp.MustCompile(`^(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]`)

func (p *inlineParser) Parse(parent ast.Node, block text.Reader, pc parser.Context) ast.Node {
	line, _ := block.PeekLine()
	if len(line) == 0 {
		return nil
	}
	if m := wikiPattern.FindSubmatch(line); m != nil {
		kind := "wiki"
		if len(m[1]) > 0 {
			kind = "wiki-image"
		}
		block.Advance(len(m[0]))
		return &coralInline{KindName: kind, Value: strings.TrimSpace(string(m[2])), Label: strings.TrimSpace(string(m[3]))}
	}
	open, close := "$", "$"
	if bytes.HasPrefix(line, []byte(`\(`)) {
		open, close = `\(`, `\)`
	} else if line[0] != '$' || len(line) > 1 && line[1] == '$' {
		return nil
	}
	if len(line) <= len(open) || unicode.IsSpace(rune(line[len(open)])) {
		return nil
	}
	end := bytes.Index(line[len(open):], []byte(close))
	if end < 0 {
		return nil
	}
	end += len(open)
	if end == len(open) || line[end-1] == '\\' || unicode.IsSpace(rune(line[end-1])) {
		return nil
	}
	value := string(line[len(open):end])
	block.Advance(end + len(close))
	return &coralInline{KindName: "math", Value: value}
}

type emphasisProcessor struct{}

func (p *emphasisProcessor) IsDelimiter(b byte) bool                   { return b == '*' }
func (p *emphasisProcessor) CanOpenCloser(a, b *parser.Delimiter) bool { return a.Char == b.Char }
func (p *emphasisProcessor) OnMatch(n int) ast.Node                    { return ast.NewEmphasis(n) }

type cjkEmphasis struct{}

func (p *cjkEmphasis) Trigger() []byte { return []byte{'*'} }
func (p *cjkEmphasis) Parse(parent ast.Node, block text.Reader, pc parser.Context) ast.Node {
	line, seg := block.PeekLine()
	before := block.PrecendingCharacter()
	d := parser.ScanDelimiter(line, before, 1, &emphasisProcessor{})
	if d == nil {
		return nil
	}
	next, _ := utf8.DecodeRune(line[d.OriginalLength:])
	if unicode.In(before, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul) && unicode.IsPunct(next) {
		d.CanOpen = true
	}
	if unicode.IsPunct(before) && unicode.In(next, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul) {
		d.CanClose = true
	}
	d.Segment = seg.WithStop(seg.Start + d.OriginalLength)
	block.Advance(d.OriginalLength)
	pc.PushDelimiter(d)
	return d
}

type markdownRenderer struct {
	Links       *linkIndex
	Current     *Document
	Metadata    map[string]any
	Headings    []RenderedHeading
	WikiTargets []string
	IDs         map[string]bool
}

func (r *markdownRenderer) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(ast.KindFencedCodeBlock, r.fence)
	reg.Register(ast.KindHeading, r.heading)
	reg.Register(ast.KindLink, r.link)
	reg.Register(ast.KindImage, r.image)
	reg.Register(ast.KindParagraph, r.paragraph)
	reg.Register(ast.KindHTMLBlock, r.htmlBlock)
	reg.Register(ast.KindRawHTML, r.rawHTML)
	reg.Register(kindCoralInline, r.inline)
}
func renderText(n ast.Node, source []byte) string {
	var b strings.Builder
	_ = ast.Walk(n, func(child ast.Node, enter bool) (ast.WalkStatus, error) {
		if enter {
			switch c := child.(type) {
			case *ast.Text:
				b.Write(c.Segment.Value(source))
				if c.SoftLineBreak() || c.HardLineBreak() {
					b.WriteByte(' ')
				}
			case *ast.String:
				b.Write(c.Value)
			case *ast.RawHTML:
				for i := 0; i < c.Segments.Len(); i++ {
					segment := c.Segments.At(i)
					b.Write(segment.Value(source))
				}
			case *coralInline:
				b.WriteString(c.Value)
			}
		}
		return ast.WalkContinue, nil
	})
	return b.String()
}
func (r *markdownRenderer) heading(w util.BufWriter, source []byte, n ast.Node, enter bool) (ast.WalkStatus, error) {
	h := n.(*ast.Heading)
	if enter {
		title := strings.TrimSpace(renderText(n, source))
		base := headingID(title)
		id := base
		for i := 1; r.IDs[id]; i++ {
			id = base + "-" + strconv.Itoa(i)
		}
		r.IDs[id] = true
		r.Headings = append(r.Headings, RenderedHeading{id, title, h.Level})
		fmt.Fprintf(w, "<h%d id=\"%s\">", h.Level, escape(id))
	} else {
		fmt.Fprintf(w, "</h%d>\n", h.Level)
	}
	return ast.WalkContinue, nil
}
func (r *markdownRenderer) fence(w util.BufWriter, source []byte, n ast.Node, enter bool) (ast.WalkStatus, error) {
	if !enter {
		return ast.WalkContinue, nil
	}
	f := n.(*ast.FencedCodeBlock)
	language := string(f.Language(source))
	info := ""
	if f.Info != nil {
		info = string(f.Info.Segment.Value(source))
	}
	var b bytes.Buffer
	for i := 0; i < f.Lines().Len(); i++ {
		s := f.Lines().At(i)
		b.Write(s.Value(source))
	}
	code := escape(b.String())
	switch strings.ToLower(language) {
	case "html":
		if len(strings.Fields(info)) < 2 || !strings.EqualFold(strings.Fields(info)[1], "source") {
			fmt.Fprintf(w, "<div class=\"html-diagram\" data-html><details class=\"html-source\"><summary>查看 HTML 源码</summary><pre><code class=\"language-html\">%s</code></pre></details></div>\n", code)
			return ast.WalkSkipChildren, nil
		}
	case "mermaid":
		fmt.Fprintf(w, "<div class=\"mermaid-diagram\" data-mermaid><pre><code class=\"language-mermaid\">%s</code></pre></div>\n", code)
		return ast.WalkSkipChildren, nil
	case "coral-math", "math", "tex":
		fmt.Fprintf(w, "<div class=\"math-expression math-display katex-block\" data-math-display data-tex=\"%s\">%s</div>\n", escape(strings.TrimSpace(b.String())), code)
		return ast.WalkSkipChildren, nil
	}
	fmt.Fprintf(w, "<pre class=\"hljs-chroma\"><code class=\"language-%s\">%s</code></pre>\n", escape(language), highlightCode(b.String(), language))
	return ast.WalkSkipChildren, nil
}
func (r *markdownRenderer) link(w util.BufWriter, source []byte, n ast.Node, enter bool) (ast.WalkStatus, error) {
	if !enter {
		w.WriteString("</a>")
		return ast.WalkContinue, nil
	}
	l := n.(*ast.Link)
	target := string(l.Destination)
	class := ""
	if strings.HasPrefix(target, "coral://vault/") {
		u, err := url.Parse(target)
		if err == nil {
			base := strings.SplitN(target, "#", 2)[0]
			target = viewURL(base)
			if u.Fragment != "" {
				target += "#" + encodeURI(headingID(u.Fragment))
			}
		}
	} else if r.Current != nil && !externalTarget(target) && isMarkdown(strings.SplitN(target, "#", 2)[0]) {
		d := r.Links.resolve(target, r.Current, true)
		if d != nil {
			fragment := ""
			if i := strings.Index(target, "#"); i >= 0 {
				v, _ := url.PathUnescape(target[i+1:])
				fragment = "#" + encodeURI(headingID(v))
			}
			target = viewURL(d.URI) + fragment
		} else {
			class = ` class="broken"`
		}
	}
	if dangerousURL(target) {
		target = ""
	}
	fmt.Fprintf(w, "<a href=\"%s\"%s", escape(target), class)
	if len(l.Title) > 0 {
		fmt.Fprintf(w, " title=\"%s\"", escape(string(l.Title)))
	}
	w.WriteString(">")
	return ast.WalkContinue, nil
}
func externalTarget(s string) bool {
	u, err := url.Parse(s)
	return err != nil || u.IsAbs() || strings.HasPrefix(s, "/") || strings.HasPrefix(s, "#")
}
func dangerousURL(s string) bool {
	lower := strings.ToLower(strings.TrimSpace(s))
	return strings.HasPrefix(lower, "javascript:") || strings.HasPrefix(lower, "vbscript:") || strings.HasPrefix(lower, "data:")
}
func imageMIME(s string) string {
	return map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif"}[strings.ToLower(path.Ext(s))]
}
func (r *markdownRenderer) imageURL(target string) string {
	if r.Current != nil && !externalTarget(target) {
		decoded, err := url.PathUnescape(target)
		if err != nil {
			return ""
		}
		relative := path.Clean(path.Join(parent(r.Current.Relative), decoded))
		if _, err := safeParts(relative, false); err != nil {
			return ""
		}
		if imageMIME(relative) != "" {
			return "/asset?uri=" + encodeURI(ResourceURI(r.Current.VaultID, relative))
		}
	}
	if dangerousURL(target) {
		return ""
	}
	return target
}

func (r *markdownRenderer) wikiImageURL(target string) string {
	if r.Current == nil {
		return ""
	}
	relative := path.Clean(path.Join(parent(r.Current.Relative), target))
	if _, err := safeParts(relative, false); err != nil {
		return ""
	}
	return "/asset?uri=" + encodeURI(ResourceURI(r.Current.VaultID, relative))
}
func (r *markdownRenderer) image(w util.BufWriter, source []byte, n ast.Node, enter bool) (ast.WalkStatus, error) {
	if enter {
		im := n.(*ast.Image)
		fmt.Fprintf(w, "<img src=\"%s\" alt=\"%s\"", escape(r.imageURL(string(im.Destination))), escape(renderText(n, source)))
		if len(im.Title) > 0 {
			fmt.Fprintf(w, " title=\"%s\"", escape(string(im.Title)))
		}
		w.WriteString(">")
		return ast.WalkSkipChildren, nil
	}
	return ast.WalkContinue, nil
}

var captionPattern = regexp.MustCompile(`(?i)^(?:图|表|Figure|Fig\.?|Table)\s*(?:\d+(?:[.\-–]\d+)*|[一二三四五六七八九十百]+)\s*[:：．、.]`)

func hasImage(n ast.Node) bool {
	found := false
	_ = ast.Walk(n, func(c ast.Node, enter bool) (ast.WalkStatus, error) {
		if enter && (c.Kind() == ast.KindImage || c.Kind() == kindCoralInline && c.(*coralInline).KindName == "wiki-image") {
			found = true
		}
		return ast.WalkContinue, nil
	})
	return found
}

func paragraphIndented(metadata map[string]any) bool {
	if value, explicit := metadata["paragraph_indent"]; explicit {
		return value == "2em"
	}
	return stringValue(metadata["coral_language"]) == "en"
}

func (r *markdownRenderer) paragraph(w util.BufWriter, source []byte, n ast.Node, enter bool) (ast.WalkStatus, error) {
	if enter {
		class := ""
		plain := strings.TrimSpace(renderText(n, source))
		narrative := false
		for child := n.FirstChild(); child != nil; child = child.NextSibling() {
			if textNode, ok := child.(*ast.Text); ok && strings.TrimSpace(string(textNode.Segment.Value(source))) != "" {
				narrative = true
			}
			if child.Kind() == ast.KindEmphasis || child.Kind() == ast.KindLink {
				narrative = true
			}
		}
		visual := false
		if prev := n.PreviousSibling(); prev != nil {
			visual = hasImage(prev) || prev.Kind() == ast.KindFencedCodeBlock || prev.Kind() == extast.KindTable
		}
		if paragraphIndented(r.Metadata) && n.Parent().Kind() == ast.KindDocument && narrative && plain != "" && !hasImage(n) && !(visual && captionPattern.MatchString(plain)) {
			class = ` class="paragraph-indent"`
		}
		w.WriteString("<p" + class + ">")
	} else {
		w.WriteString("</p>\n")
	}
	return ast.WalkContinue, nil
}
func (r *markdownRenderer) htmlBlock(w util.BufWriter, source []byte, n ast.Node, enter bool) (ast.WalkStatus, error) {
	if enter {
		b := n.(*ast.HTMLBlock)
		for i := 0; i < b.Lines().Len(); i++ {
			s := b.Lines().At(i)
			w.WriteString(escape(string(s.Value(source))))
		}
		if b.HasClosure() {
			w.WriteString(escape(string(b.ClosureLine.Value(source))))
		}
	}
	return ast.WalkSkipChildren, nil
}
func (r *markdownRenderer) rawHTML(w util.BufWriter, source []byte, n ast.Node, enter bool) (ast.WalkStatus, error) {
	if enter {
		b := n.(*ast.RawHTML)
		for i := 0; i < b.Segments.Len(); i++ {
			s := b.Segments.At(i)
			w.WriteString(escape(string(s.Value(source))))
		}
	}
	return ast.WalkSkipChildren, nil
}
func (r *markdownRenderer) inline(w util.BufWriter, source []byte, n ast.Node, enter bool) (ast.WalkStatus, error) {
	if !enter {
		return ast.WalkContinue, nil
	}
	in := n.(*coralInline)
	switch in.KindName {
	case "math":
		fmt.Fprintf(w, "<span class=\"math-expression\" data-tex=\"%s\">%s</span>", escape(in.Value), escape(in.Value))
	case "wiki-image":
		if r.Current == nil || imageMIME(in.Value) == "" {
			w.WriteString(escape("![[" + in.Value + "]]"))
			break
		}
		width := ""
		if _, err := strconv.Atoi(in.Label); err == nil && len(in.Label) <= 4 {
			width = ` width="` + escape(in.Label) + `"`
		}
		fmt.Fprintf(w, "<img src=\"%s\" alt=\"%s\"%s>", escape(r.wikiImageURL(in.Value)), escape(in.Value), width)
	case "wiki":
		r.WikiTargets = append(r.WikiTargets, in.Value)
		label := in.Label
		if label == "" {
			label = in.Value
		}
		d := r.Links.resolve(in.Value, r.Current, false)
		target := ""
		class := ""
		if d != nil {
			target = viewURL(d.URI)
			if i := strings.Index(in.Value, "#"); i >= 0 {
				target += "#" + encodeURI(headingID(in.Value[i+1:]))
			}
		} else {
			id := "default"
			if r.Current != nil {
				id = r.Current.VaultID
			}
			target = "/new?vault=" + encodeURI(id) + "&title=" + encodeURI(strings.SplitN(in.Value, "#", 2)[0])
			class = ` class="broken" title="页面不存在"`
		}
		fmt.Fprintf(w, "<a href=\"%s\"%s>%s</a>", escape(target), class, escape(label))
	}
	return ast.WalkSkipChildren, nil
}
func mathBlocks(body string) string {
	lines := strings.SplitAfter(body, "\n")
	var out strings.Builder
	fence := ""
	math := false
	closer := ""
	for _, line := range lines {
		trim := strings.TrimSpace(line)
		if !math {
			if m := fenceStart.FindStringSubmatch(line); m != nil {
				if fence == "" {
					fence = m[1]
				} else if m[1][0] == fence[0] && len(m[1]) >= len(fence) && strings.TrimSpace(m[2]) == "" {
					fence = ""
				}
				out.WriteString(line)
				continue
			}
			if fence == "" && (trim == "$$" || trim == `\[`) {
				math = true
				closer = "$$"
				if trim == `\[` {
					closer = `\]`
				}
				out.WriteString("```coral-math\n")
				continue
			}
		} else if trim == closer {
			math = false
			out.WriteString("```\n")
			continue
		}
		out.WriteString(line)
	}
	if math {
		out.WriteString("\n```\n")
	}
	return out.String()
}
func RenderMarkdown(body string, documents []Document, current *Document, metadata map[string]any, indexes ...*linkIndex) (RenderedMarkdown, error) {
	var links *linkIndex
	if len(indexes) > 0 {
		links = indexes[0]
	} else {
		links = newLinkIndex(documents)
	}
	r := &markdownRenderer{Links: links, Current: current, Metadata: metadata, IDs: map[string]bool{}, Headings: []RenderedHeading{}, WikiTargets: []string{}}
	md := goldmark.New(goldmark.WithExtensions(extension.GFM), goldmark.WithParserOptions(parser.WithInlineParsers(util.Prioritized(&inlineParser{}, 90), util.Prioritized(&cjkEmphasis{}, 400))), goldmark.WithRendererOptions(renderer.WithNodeRenderers(util.Prioritized(r, 100))))
	var b bytes.Buffer
	if err := md.Convert([]byte(mathBlocks(body)), &b); err != nil {
		return RenderedMarkdown{}, err
	}
	return RenderedMarkdown{b.String(), r.Headings, r.WikiTargets}, nil
}

func wikiTargets(body string) []string {
	md := goldmark.New(goldmark.WithParserOptions(parser.WithInlineParsers(util.Prioritized(&inlineParser{}, 90))))
	root := md.Parser().Parse(text.NewReader([]byte(body)))
	result := []string{}
	_ = ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if in, ok := n.(*coralInline); ok && in.KindName == "wiki" {
				result = append(result, in.Value)
			}
		}
		return ast.WalkContinue, nil
	})
	return result
}
