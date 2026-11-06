// Command alpha16-graph is the M0 read-only source auditor for the alpha.16 program.
//
// It parses every owned Go file with go/parser (no third-party dependencies) and emits a
// deterministic JSON graph of packages, imports, top-level declarations, package-level mutable
// state, synchronisation primitives, goroutines, timers, child processes, context detachment,
// filesystem mutations, HTTP calls, lock/atomic calls and explicit sleeps.
//
// It does not decide whether any of those facts is a defect. Its only job is to make the audit's
// coverage mechanical and countable: every owned production file appears with its facts, so a lane
// cannot quietly leave a file out, and the ownership map can cite a generated fact instead of a
// hand-written impression (docs/alpha16/README.md, M0 rule 7).
//
// Usage:
//
//	go run ./tools/alpha16-graph -root . -out docs/alpha16/source-graph.json -commit "$(git rev-parse HEAD)"
//
// The output is deterministic for a given tree: files are sorted by path and facts by line, and no
// timestamp is recorded, so re-running it on the same commit produces the same bytes.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const modulePrefix = "github.com/cocokoishi/gotavern/"

type decl struct {
	Kind string `json:"kind"` // func | method | type | var | const
	Name string `json:"name"`
	Recv string `json:"recv,omitempty"`
	Line int    `json:"line"`
}

type fact struct {
	Kind string `json:"kind"`
	Sym  string `json:"sym"`
	Recv string `json:"recv,omitempty"`
	Fn   string `json:"fn,omitempty"`
	Line int    `json:"line"`
}

type fileInfo struct {
	Path      string   `json:"path"`
	Package   string   `json:"package"`
	Test      bool     `json:"test"`
	Generated bool     `json:"generated,omitempty"`
	BuildTags []string `json:"buildTags,omitempty"`
	Lines     int      `json:"lines"`
	Imports   []string `json:"imports,omitempty"`
	Decls     []decl   `json:"decls,omitempty"`
	Globals   []decl   `json:"globals,omitempty"`
	Facts     []fact   `json:"facts,omitempty"`
}

type pkgInfo struct {
	Path      string   `json:"path"`
	Files     int      `json:"files"`
	TestFiles int      `json:"testFiles"`
	Lines     int      `json:"lines"`
	Internal  []string `json:"internal,omitempty"`
	External  []string `json:"external,omitempty"`
}

type summary struct {
	Files            int            `json:"files"`
	ProductionFiles  int            `json:"productionFiles"`
	TestFiles        int            `json:"testFiles"`
	GeneratedFiles   int            `json:"generatedFiles"`
	Packages         int            `json:"packages"`
	FactsByKind      map[string]int `json:"factsByKind"`
	ParseErrors      []string       `json:"parseErrors,omitempty"`
	BuildTaggedFiles int            `json:"buildTaggedFiles"`
}

type graph struct {
	SchemaVersion int         `json:"schemaVersion"`
	Generator     string      `json:"generator"`
	Root          string      `json:"root"`
	Commit        string      `json:"commit"`
	Summary       summary     `json:"summary"`
	Packages      []*pkgInfo  `json:"packages"`
	Files         []*fileInfo `json:"files"`
}

// Registry of package-qualified call names that the audit cares about, grouped by the resolved
// import base name. os.OpenFile is classified as fs-open (flags decide read vs write), and the
// auditor records the call site rather than pretending to resolve the flags.
var pkgCallKinds = map[string]map[string]string{
	"os": {
		"WriteFile": "fs-write", "Create": "fs-write",
		"OpenFile": "fs-open", "Rename": "fs-rename",
		"Remove": "fs-remove", "RemoveAll": "fs-remove",
		"Mkdir": "fs-mkdir", "MkdirAll": "fs-mkdir",
		"Chmod": "fs-chmod", "Chown": "fs-chown",
		"Symlink": "fs-symlink", "Link": "fs-link",
		"Chtimes": "fs-chtimes", "Truncate": "fs-truncate",
	},
	"ioutil": {
		"WriteFile": "fs-write", "ReadFile": "fs-read",
		"TempDir": "fs-temp", "TempFile": "fs-temp",
	},
	"filepath": {
		"Walk": "fs-walk", "WalkDir": "fs-walk",
	},
	"exec": {
		"Command": "exec", "CommandContext": "exec",
	},
	"http": {
		"Get": "http", "Post": "http", "PostForm": "http",
		"NewRequest": "http", "NewRequestWithContext": "http",
	},
	"time": {
		"AfterFunc": "timer", "NewTicker": "timer", "Tick": "timer",
		"NewTimer": "timer", "After": "timer", "Sleep": "sleep",
	},
	"context": {
		"Background": "context", "TODO": "context",
	},
}

var syncTypeNames = map[string]bool{
	"Mutex": true, "RWMutex": true, "Once": true, "WaitGroup": true,
	"Map": true, "Cond": true, "Pool": true,
}

// Modules whose exports are lock/atomic primitives. A call through them is recorded as lock-call so
// the concurrency lane can start from a generated list instead of a hand search.
var lockPkgs = map[string]bool{
	"lockacquire": true, "startup": true, "fsretry": true, "userdata": true,
}

var localLockCalls = map[string]bool{
	"atomicReplace": true, "atomicWrite": true, "withUserLock": true,
	"acquireUserLock": true, "lockUser": true,
}

var skipDirs = map[string]bool{
	".git": true, "node_modules": true, ".browser-bin": true, "backups": true,
	"dist": true, "_storage": true, "_uploads": true, ".private-fixtures": true,
	".pinned-boot-lock": true, "logs": true, "certs": true, ".github": true,
	"public": true, "vendor": true, "upstream/generated": true,
}

func main() {
	root := flag.String("root", ".", "repository root to scan")
	out := flag.String("out", "", "output JSON path (empty means stdout)")
	commit := flag.String("commit", "", "commit sha to record as provenance")
	flag.Parse()

	g := &graph{
		SchemaVersion: 1,
		Generator:     "tools/alpha16-graph",
		Root:          filepath.ToSlash(*root),
		Commit:        *commit,
		Summary: summary{
			FactsByKind: map[string]int{},
		},
	}
	pkgs := map[string]*pkgInfo{}
	fset := token.NewFileSet()

	err := filepath.WalkDir(*root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			g.Summary.ParseErrors = append(g.Summary.ParseErrors, walkErr.Error())
			return nil
		}
		rel, relErr := filepath.Rel(*root, path)
		if relErr != nil {
			rel = path
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			name := d.Name()
			if skipDirs[name] || skipDirs[rel] {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") {
			return nil
		}
		fi, err := scanFile(fset, path, rel)
		if err != nil {
			g.Summary.ParseErrors = append(g.Summary.ParseErrors, err.Error())
			return nil
		}
		g.Files = append(g.Files, fi)
		g.Summary.Files++
		if fi.Test {
			g.Summary.TestFiles++
		} else {
			g.Summary.ProductionFiles++
		}
		if fi.Generated {
			g.Summary.GeneratedFiles++
		}
		if len(fi.BuildTags) > 0 {
			g.Summary.BuildTaggedFiles++
		}
		for _, f := range fi.Facts {
			g.Summary.FactsByKind[f.Kind]++
		}
		p := pkgs[fi.Package]
		if p == nil {
			p = &pkgInfo{Path: fi.Package}
			pkgs[fi.Package] = p
		}
		p.Files++
		p.Lines += fi.Lines
		if fi.Test {
			p.TestFiles++
		}
		return nil
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "alpha16-graph: walk: %v\n", err)
		os.Exit(1)
	}

	sort.Slice(g.Files, func(i, j int) bool { return g.Files[i].Path < g.Files[j].Path })
	for _, p := range pkgs {
		internal := map[string]bool{}
		external := map[string]bool{}
		for _, fi := range g.Files {
			if fi.Package != p.Path {
				continue
			}
			for _, imp := range fi.Imports {
				if strings.HasPrefix(imp, modulePrefix) {
					internal[imp] = true
				} else {
					external[imp] = true
				}
			}
		}
		p.Internal = sortedKeys(internal)
		p.External = sortedKeys(external)
	}
	for _, p := range pkgs {
		g.Packages = append(g.Packages, p)
	}
	sort.Slice(g.Packages, func(i, j int) bool { return g.Packages[i].Path < g.Packages[j].Path })
	g.Summary.Packages = len(g.Packages)

	payload, err := json.Marshal(g)
	if err != nil {
		fmt.Fprintf(os.Stderr, "alpha16-graph: marshal: %v\n", err)
		os.Exit(1)
	}
	payload = append(payload, '\n')
	if *out == "" {
		os.Stdout.Write(payload)
		return
	}
	if err := os.WriteFile(*out, payload, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "alpha16-graph: write %s: %v\n", *out, err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stdout, "alpha16-graph: %d files (%d production, %d test, %d generated), %d packages, %d bytes -> %s\n",
		g.Summary.Files, g.Summary.ProductionFiles, g.Summary.TestFiles, g.Summary.GeneratedFiles,
		g.Summary.Packages, len(payload), *out)
	kinds := make([]string, 0, len(g.Summary.FactsByKind))
	for k := range g.Summary.FactsByKind {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	for _, k := range kinds {
		fmt.Fprintf(os.Stdout, "  %-14s %d\n", k, g.Summary.FactsByKind[k])
	}
	if len(g.Summary.ParseErrors) > 0 {
		fmt.Fprintf(os.Stdout, "  PARSE ERRORS: %d\n", len(g.Summary.ParseErrors))
		for _, e := range g.Summary.ParseErrors {
			fmt.Fprintf(os.Stdout, "    %s\n", e)
		}
	}
}

func scanFile(fset *token.FileSet, path, rel string) (*fileInfo, error) {
	src, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	af, err := parser.ParseFile(fset, path, src, parser.ParseComments)
	if err != nil {
		return nil, err
	}
	fi := &fileInfo{
		Path:    rel,
		Package: filepath.ToSlash(filepath.Dir(rel)),
		Test:    strings.HasSuffix(rel, "_test.go"),
		Lines:   bytes.Count(src, []byte("\n")) + 1,
	}
	if fi.Package == "." {
		fi.Package = "."
	}
	head := src
	if len(head) > 4096 {
		head = head[:4096]
	}
	fi.Generated = bytes.Contains(head, []byte("Code generated"))
	for _, cg := range af.Comments {
		for _, c := range cg.List {
			if strings.HasPrefix(c.Text, "//go:build ") {
				fi.BuildTags = append(fi.BuildTags, strings.TrimSpace(strings.TrimPrefix(c.Text, "//go:build ")))
			}
		}
	}

	aliases := map[string]string{} // local package name -> resolved base name
	for _, spec := range af.Imports {
		p := spec.Path.Value
		if uq, uerr := strconv.Unquote(p); uerr == nil {
			p = uq
		}
		fi.Imports = append(fi.Imports, p)
		base := p
		if i := strings.LastIndex(base, "/"); i >= 0 {
			base = base[i+1:]
		}
		if spec.Name != nil && spec.Name.Name != "_" && spec.Name.Name != "." {
			aliases[spec.Name.Name] = base
		} else if spec.Name == nil {
			aliases[base] = base
		}
	}

	for _, d := range af.Decls {
		switch dt := d.(type) {
		case *ast.FuncDecl:
			fnName := dt.Name.Name
			recv := ""
			if dt.Recv != nil && len(dt.Recv.List) > 0 {
				recv = typeText(fset, dt.Recv.List[0].Type)
				fnName = recv + "." + dt.Name.Name
				fi.Decls = append(fi.Decls, decl{Kind: "method", Name: dt.Name.Name, Recv: recv, Line: fset.Position(dt.Pos()).Line})
			} else {
				fi.Decls = append(fi.Decls, decl{Kind: "func", Name: dt.Name.Name, Line: fset.Position(dt.Pos()).Line})
			}
			if dt.Body != nil {
				scanBody(fset, dt.Body, fnName, aliases, fi)
			}
		case *ast.GenDecl:
			kind := "var"
			if dt.Tok == token.CONST {
				kind = "const"
			}
			for _, spec := range dt.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					fi.Decls = append(fi.Decls, decl{Kind: "type", Name: s.Name.Name, Line: fset.Position(s.Pos()).Line})
					if st, ok := s.Type.(*ast.StructType); ok {
						for _, fld := range st.Fields.List {
							if fld.Type == nil {
								continue
							}
							if sel, ok := fld.Type.(*ast.SelectorExpr); ok {
								if id, ok := sel.X.(*ast.Ident); ok && aliases[id.Name] == "sync" && syncTypeNames[sel.Sel.Name] {
									fi.Facts = append(fi.Facts, fact{Kind: "sync-field", Sym: sel.Sel.Name, Fn: s.Name.Name, Line: fset.Position(fld.Pos()).Line})
								}
							}
						}
					}
				case *ast.ValueSpec:
					for _, n := range s.Names {
						fi.Decls = append(fi.Decls, decl{Kind: kind, Name: n.Name, Line: fset.Position(n.Pos()).Line})
					}
					if kind == "var" {
						for _, n := range s.Names {
							fi.Globals = append(fi.Globals, decl{Kind: "var", Name: n.Name, Recv: typeText(fset, s.Type), Line: fset.Position(n.Pos()).Line})
						}
					}
				}
			}
		}
	}

	sort.Slice(fi.Facts, func(i, j int) bool {
		if fi.Facts[i].Line != fi.Facts[j].Line {
			return fi.Facts[i].Line < fi.Facts[j].Line
		}
		return fi.Facts[i].Kind < fi.Facts[j].Kind
	})
	return fi, nil
}

func scanBody(fset *token.FileSet, body *ast.BlockStmt, fnName string, aliases map[string]string, fi *fileInfo) {
	ast.Inspect(body, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.GoStmt:
			sym := "go"
			if call, ok := x.Call.Fun.(*ast.SelectorExpr); ok {
				sym = typeText(fset, call.X) + "." + call.Sel.Name
			} else if id, ok := x.Call.Fun.(*ast.Ident); ok {
				sym = id.Name
			}
			fi.Facts = append(fi.Facts, fact{Kind: "goroutine", Sym: sym, Fn: fnName, Line: fset.Position(x.Pos()).Line})
		case *ast.CallExpr:
			classifyCall(fset, x, fnName, aliases, fi)
		case *ast.SelectorExpr:
			// sync.Mutex used as a local variable type, or sync.Map etc.
			if id, ok := x.X.(*ast.Ident); ok && aliases[id.Name] == "sync" && syncTypeNames[x.Sel.Name] {
				fi.Facts = append(fi.Facts, fact{Kind: "sync-type", Sym: x.Sel.Name, Fn: fnName, Line: fset.Position(x.Pos()).Line})
			}
		}
		return true
	})
}

func classifyCall(fset *token.FileSet, call *ast.CallExpr, fnName string, aliases map[string]string, fi *fileInfo) {
	line := fset.Position(call.Pos()).Line
	switch fun := call.Fun.(type) {
	case *ast.SelectorExpr:
		sel := fun.Sel.Name
		if id, ok := fun.X.(*ast.Ident); ok {
			if base, ok := aliases[id.Name]; ok {
				if kinds := pkgCallKinds[base]; kinds != nil {
					if kind := kinds[sel]; kind != "" {
						fi.Facts = append(fi.Facts, fact{Kind: kind, Sym: base + "." + sel, Recv: base, Fn: fnName, Line: line})
						return
					}
				}
				if base == "sync/atomic" || base == "atomic" {
					fi.Facts = append(fi.Facts, fact{Kind: "atomic", Sym: base + "." + sel, Recv: base, Fn: fnName, Line: line})
					return
				}
				if lockPkgs[base] && (strings.Contains(strings.ToLower(sel), "lock") || sel == "UpdateUserContentFile" || strings.Contains(strings.ToLower(sel), "atomic")) {
					fi.Facts = append(fi.Facts, fact{Kind: "lock-call", Sym: base + "." + sel, Recv: base, Fn: fnName, Line: line})
					return
				}
			}
		}
		// Method calls like client.Do / httpClient.Do are HTTP when the receiver is not an import.
		if sel == "Do" {
			fi.Facts = append(fi.Facts, fact{Kind: "http-do", Sym: typeText(fset, fun.X) + ".Do", Recv: typeText(fset, fun.X), Fn: fnName, Line: line})
			return
		}
	case *ast.Ident:
		if localLockCalls[fun.Name] {
			fi.Facts = append(fi.Facts, fact{Kind: "lock-call", Sym: fun.Name, Fn: fnName, Line: line})
			return
		}
		if fun.Name == "panic" {
			fi.Facts = append(fi.Facts, fact{Kind: "panic", Sym: "panic", Fn: fnName, Line: line})
		}
	}
}

func typeText(fset *token.FileSet, e ast.Expr) string {
	if e == nil {
		return ""
	}
	var buf bytes.Buffer
	if err := printer.Fprint(&buf, fset, e); err != nil {
		return ""
	}
	return buf.String()
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
