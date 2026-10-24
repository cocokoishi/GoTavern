package server

// THE DUPLICATE-DISPATCH-ARM CONTROL, AND WHY IT IS A SOURCE SCANNER RATHER THAN A BEHAVIOUR TEST.
//
// The chat-completion dispatch used to be two long `if source == ... { return ... }` chains, one for the
// PLAN side and one for the RESPONSE side, plus a third in the /status route. An `if` chain lets the same
// source appear TWICE and nothing objects: `go build` is happy, `go vet` is happy (no unreachable-code
// analysis fires, because an `if` after a `return` is not `if false`), and every existing test still
// passes, because the second arm is DEAD -- the first one always returns first. The duplicates that
// accumulated that way were AI21, COHERE, CHUTES and AIMLAPI on the plan chain, CHUTES, COHERE and
// MINIMAX on the response chain, and ZAI, CHUTES and COHERE on the /status chain.
//
// A behaviour test cannot see them BY CONSTRUCTION: two identical arms have identical behaviour, so the
// provider-wire replay is green both before and after a duplicate is introduced. A test that could only
// go green after the refactor would prove nothing about the duplicates. The defect is in the SOURCE
// STRUCTURE, so the assertion has to be about the source structure.
//
// WHAT IS SCANNED, and why it is not a brittle text match: the package's own non-test .go files are parsed
// with go/ast, and an arm is counted only when BOTH halves of an `==` comparison look like source routing:
//
//   - the DISCRIMINANT (the expression being tested) must NAME a source -- its rendered text must contain
//     "source" case-insensitively. That is what every chain in this package writes (`sourceName`, `source`,
//     `pinnedChatCompletionSourceName(body)`), and it is what distinguishes a source arm from the two
//     repeated string comparisons that are NOT source routing and must not be reported: the windows path
//     normalisation in image_metadata_folder_assignments.go (`runtime.GOOS == "windows"`, twice, both
//     reachable) and the caption route's include/exclude fold in openai_caption.go (`api == "custom"`,
//     twice, both reachable).
//   - the VALUE must be a name the pinned chat-completion matrix actually routes, i.e. a key of
//     pinnedChatCompletionSources. A comparison against a constant or a literal that is not a source is not
//     a source arm.
//
// Grouping is BY FUNCTION, not by file: the same source is legitimately dispatched in two different
// functions (generate and status), and only a repeat WITHIN one function is dead.

import (
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// dispatchArm is one `<discriminant> == <source name>` arm found in a function body.
type dispatchArm struct {
	function     string
	file         string
	line         int
	discriminant string
	// value is the source name the arm compares against; valueLabel is how the arm wrote it, which is the
	// constant's identifier where the arm names one.
	value      string
	valueLabel string
}

// packageStringConstants returns the value of every package-level string constant in the parsed files,
// keyed by identifier, so an arm written as `source == chatCompletionSourceAI21` can be reported as
// `("ai21")` rather than as an identifier a reader has to chase.
func packageStringConstants(files map[string]*ast.File) map[string]string {
	constants := map[string]string{}
	for _, file := range files {
		for _, declaration := range file.Decls {
			generic, isGeneric := declaration.(*ast.GenDecl)
			if !isGeneric || generic.Tok != token.CONST {
				continue
			}
			for _, specification := range generic.Specs {
				valueSpec, isValueSpec := specification.(*ast.ValueSpec)
				if !isValueSpec {
					continue
				}
				for index, name := range valueSpec.Names {
					if index >= len(valueSpec.Values) {
						continue
					}
					literal, isLiteral := valueSpec.Values[index].(*ast.BasicLit)
					if !isLiteral || literal.Kind != token.STRING {
						continue
					}
					text, err := strconv.Unquote(literal.Value)
					if err != nil {
						continue
					}
					constants[name.Name] = text
				}
			}
		}
	}
	return constants
}

// renderExpression prints an expression with the standard printer so two arms that write the same
// comparison differently only by whitespace compare equal.
func renderExpression(fileSet *token.FileSet, expression ast.Expr) string {
	var builder strings.Builder
	if err := printer.Fprint(&builder, fileSet, expression); err != nil {
		return ""
	}
	return builder.String()
}

// namesAChatCompletionSource reports whether a rendered discriminant is one that tests a source. See the
// file comment for why the test is "the expression mentions a source" rather than a list of the identifiers
// that happen to be used today.
func namesAChatCompletionSource(discriminant string) bool {
	return strings.Contains(strings.ToLower(discriminant), "source")
}

// resolveSourceArmValue resolves the value side of a comparison to a pinned source name. It reports false
// when the expression is not a package string constant or a string literal, or when the name it resolves to
// is not one the pinned chat-completion matrix routes.
func resolveSourceArmValue(expression ast.Expr, constants map[string]string) (value string, label string, isSourceArm bool) {
	var text string
	var written string
	switch typed := expression.(type) {
	case *ast.Ident:
		resolved, known := constants[typed.Name]
		if !known {
			return "", "", false
		}
		text, written = resolved, typed.Name
	case *ast.BasicLit:
		if typed.Kind != token.STRING {
			return "", "", false
		}
		resolved, err := strconv.Unquote(typed.Value)
		if err != nil {
			return "", "", false
		}
		text, written = resolved, strconv.Quote(resolved)
	default:
		return "", "", false
	}
	if !pinnedChatCompletionSources[text] {
		return "", "", false
	}
	return text, written, true
}

// parsePackageFiles parses every non-test Go file in the package directory.
func parsePackageFiles(t *testing.T) (map[string]*ast.File, *token.FileSet) {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read the package directory: %v", err)
	}
	fileSet := token.NewFileSet()
	files := map[string]*ast.File{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		parsed, parseErr := parser.ParseFile(fileSet, name, nil, parser.ParseComments)
		if parseErr != nil {
			t.Fatalf("%s: parse: %v", name, parseErr)
		}
		files[name] = parsed
	}
	if len(files) == 0 {
		// A scan over nothing reports every function as clean, which is the vacuous green this control
		// exists to prevent.
		t.Fatal("no non-test Go files were parsed; the dispatch scan would be vacuous")
	}
	return files, fileSet
}

// collectDispatchArms returns every source arm in the package.
func collectDispatchArms(t *testing.T) []dispatchArm {
	t.Helper()
	files, fileSet := parsePackageFiles(t)
	constants := packageStringConstants(files)

	arms := make([]dispatchArm, 0, 128)
	for name, file := range files {
		for _, declaration := range file.Decls {
			function, isFunction := declaration.(*ast.FuncDecl)
			if !isFunction || function.Body == nil {
				continue
			}
			ast.Inspect(function.Body, func(node ast.Node) bool {
				statement, isIf := node.(*ast.IfStmt)
				if !isIf || statement.Init != nil {
					return true
				}
				comparison, isComparison := statement.Cond.(*ast.BinaryExpr)
				if !isComparison || comparison.Op != token.EQL {
					return true
				}
				// Try both orientations; an arm may be written `C == X` as well as `X == C`.
				for _, sides := range [2][2]ast.Expr{
					{comparison.X, comparison.Y},
					{comparison.Y, comparison.X},
				} {
					discriminant := renderExpression(fileSet, sides[0])
					if !namesAChatCompletionSource(discriminant) {
						continue
					}
					value, label, isSourceArm := resolveSourceArmValue(sides[1], constants)
					if !isSourceArm {
						continue
					}
					arms = append(arms, dispatchArm{
						function:     function.Name.Name,
						file:         name,
						line:         fileSet.Position(statement.Pos()).Line,
						discriminant: discriminant,
						value:        value,
						valueLabel:   label,
					})
					break
				}
				return true
			})
		}
	}
	return arms
}

// duplicatedSourceArms groups arms by (function, discriminant, value) and returns one human-readable line
// per source that appears more than once in one function. It is a separate function so the self-test below
// can drive it with synthetic arms and prove the grouping can report a duplicate at all.
func duplicatedSourceArms(arms []dispatchArm) []string {
	type groupKey struct {
		function     string
		discriminant string
		value        string
	}
	grouped := map[groupKey][]dispatchArm{}
	for _, arm := range arms {
		key := groupKey{function: arm.function, discriminant: arm.discriminant, value: arm.value}
		grouped[key] = append(grouped[key], arm)
	}
	duplicates := make([]string, 0)
	for key, group := range grouped {
		if len(group) < 2 {
			continue
		}
		positions := make([]string, 0, len(group))
		for _, arm := range group {
			positions = append(positions, arm.file+":"+strconv.Itoa(arm.line))
		}
		duplicates = append(duplicates, "  "+key.function+": "+key.discriminant+" == "+group[0].valueLabel+
			" ("+strconv.Quote(key.value)+") is dispatched "+strconv.Itoa(len(group))+" times, at "+
			strings.Join(positions, ", "))
	}
	sort.Strings(duplicates)
	return duplicates
}

// TestNoSourceIsDispatchedTwiceInOneFunction is the control: a function routes each source at most once.
//
// WHAT THE RULE PROVES, AND WHAT IT DOES NOT. Two shapes produce a repeated source in one function, and
// only one of them is *provably* dead on its own:
//
//   - two arms for the same source in the SAME chain. The first returns, so every later arm is
//     unreachable. This is how the Chutes, Cohere and Minimax dead arms in the response chain and the
//     AI21/COHERE/CHUTES/AIMLAPI dead arms in the plan chain arose.
//   - one arm in the failure chain and another in the response chain. Both are reachable, so neither is
//     dead by itself -- but this is the shape that HID the dead arms above: once a function routes the same
//     source in several places, a copy-pasted arm looks exactly like the existing ones and a reader
//     comparing them cannot tell which of them the compiler knows about.
//
// The rule is therefore one dispatch per source per function, and the refactor satisfies it by routing each
// source exactly once -- through its registry row, whose `plan` and `response` and `transportFailure` are
// fields rather than three independent chains.
func TestNoSourceIsDispatchedTwiceInOneFunction(t *testing.T) {
	arms := collectDispatchArms(t)
	if len(arms) == 0 {
		t.Fatal("no source arms were found anywhere in the package, so this control is vacuous; either the " +
			"scan has stopped matching or every dispatch became a table lookup -- in the second case delete " +
			"this test deliberately rather than leaving a green that cannot fail")
	}
	if duplicates := duplicatedSourceArms(arms); len(duplicates) > 0 {
		t.Fatalf("one function dispatches the same source more than once, so the source's routing is split "+
			"across several arms and a dead one cannot be told from a live one:\n%s\n"+
			"Route each source once per function -- one registry lookup -- rather than deleting an extra arm "+
			"by hand: an if-chain makes the mistake legal, so it will be made again.",
			strings.Join(duplicates, "\n"))
	}
}

// TestTheDispatchDuplicateControlCanSeeADuplicate proves the detector is not vacuous. Without it, a
// grouping bug (a key that never matches, a length test with the wrong sign) would report every tree as
// clean forever, which is exactly the failure mode this whole control exists to catch.
func TestTheDispatchDuplicateControlCanSeeADuplicate(t *testing.T) {
	arms := []dispatchArm{
		{function: "chain", file: "first.go", line: 10, discriminant: "source", value: "ai21", valueLabel: "chatCompletionSourceAI21"},
		{function: "chain", file: "second.go", line: 20, discriminant: "source", value: "ai21", valueLabel: "chatCompletionSourceAI21"},
		{function: "chain", file: "third.go", line: 30, discriminant: "source", value: "cohere", valueLabel: "chatCompletionSourceCohere"},
		// The same source in a DIFFERENT function is legitimate and must not be reported.
		{function: "otherChain", file: "first.go", line: 40, discriminant: "source", value: "ai21", valueLabel: "chatCompletionSourceAI21"},
	}
	duplicates := duplicatedSourceArms(arms)
	if len(duplicates) != 1 {
		t.Fatalf("synthetic arms with exactly one duplicated source produced %d duplicate reports, want 1: %v",
			len(duplicates), duplicates)
	}
	if !strings.Contains(duplicates[0], "ai21") || !strings.Contains(duplicates[0], "first.go:10") {
		t.Fatalf("the duplicate report does not name the source and both positions: %s", duplicates[0])
	}
}
