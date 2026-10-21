# Pinned frontend compatibility measurement (increment 0)

Pinned SillyTavern checkout: `C:\Users\koishi\Desktop\GoTavern\SillyTavern`
GoTavern: `gotavern start --port 56103 --dataRoot <scratch>`
Pinned suite: 121 specs, run unmodified from the checkout with Playwright pinned to 1.56.1.

Expected failures are not defects: this is an inventory of what the pinned frontend needs from the server, and the failure mode per spec is the useful part. The banner below says what the run does and does not support.

## Per-file status and cost

Statuses are `passed`, `failed`, `hung` (killed at the file timeout, so unmeasured) or `not-run`.
A hung file is not a failing file: its specs were never measured.

| file | status | specs | passed | failed | hung | wall clock (s) |
| --- | --- | --- | --- | --- | --- | --- |
| AddSwipeNoReload.e2e.js | passed | 1 | 1 | 0 | 0 | 16 |
| DeleteToolCalls.e2e.js | passed | 1 | 1 | 0 | 0 | 13 |
| MacroEngine.e2e.js | hung | 1 | 0 | 0 | 1 | 0 |
| MacroEnvBuilder.e2e.js | failed | 19 | 11 | 8 | 0 | 188 |
| MacroLexer.e2e.js | hung | 1 | 0 | 0 | 1 | 0 |
| MacroParser.e2e.js | passed | 49 | 49 | 0 | 0 | 209 |
| MacroRegistry.e2e.js | hung | 1 | 0 | 0 | 1 | 0 |
| MacroSlashCommands.e2e.js | failed | 12 | 4 | 8 | 0 | 124 |
| MacroStoryString.e2e.js | passed | 1 | 1 | 0 | 0 | 13 |
| MacrosParser.e2e.js | passed | 2 | 2 | 0 | 0 | 19 |
| MessageFormatter.e2e.js | failed | 15 | 12 | 3 | 0 | 133 |
| QuickReplyOverwriteCancel.e2e.js | passed | 2 | 2 | 0 | 0 | 20 |
| ReasoningHiddenBlocks.e2e.js | failed | 14 | 7 | 7 | 0 | 128 |
| WorldInfoRenameChatLore.e2e.js | passed | 1 | 1 | 0 | 0 | 13 |
| WorldInfoRenamePersonaLore.e2e.js | passed | 1 | 1 | 0 | 0 | 14 |


## What this measures, and the strongest finding

The pinned frontend suite, run unmodified from the pinned checkout against a live GoTavern, with Playwright
pinned to 1.56.1. 121 specs were measured: 92 passed. Three files could not be measured inside the per-file
budget and are recorded as hung, not as failures.

THE STRONGEST RESULT IS THAT THE ASSEMBLED FRONTEND WORKS AGAINST GOTAVERN. The passing specs are not
isolated unit checks: they boot the real page, wait for the preloader, authenticate through our middleware,
load settings and chat state, mutate it and re-render it, and import frontend modules in-page with
`import('./script.js')`. Chat mutation (AddSwipeNoReload, DeleteToolCalls, QuickReplyOverwriteCancel),
world-info rename retargeting, message formatting hooks, quick replies, and 49 of 49 macro parser specs pass.
That is a statement about the middleware and settings stack as a whole, which no single route oracle we have
built could make.

## How to read the rest

Statuses per file are passed, failed, hung or not-run, and the per-spec table gives the mode of each
non-pass. Two cautions, because both would be misread:

1. A hung file is unmeasured, not failing. MacroEngine (268 specs), MacroLexer (76) and MacroRegistry (32)
   exceeded the per-file budget with four workers; their specs were never run. MacroEngine alone needs a
   budget or a subset of its own.
2. Most timeouts are not yet evidence of divergence. Sixteen specs report "did not reach the state the spec
   waits for", and those files run 19 to 49 specs each with four parallel browsers against one server. The
   same files pass most of their other specs, so load is the first hypothesis to exclude before treating any
   of them as a compatibility gap. They are listed for triage, not counted as defects.

The seven assertion mismatches are the interesting group, because an assertion mismatch is a behavioural
answer rather than a timeout: MacroSlashCommands arg/wildcard macros (4), ReasoningHiddenBlocks whitespace
reasoning (3). They are candidates for triage, not conclusions: each could be a frontend behaviour that
depends on seeded display settings the harness does not yet provide.

## Per-file cost, for the CI policy

The fast files are affordable per pull request; the macro files are not. Measured wall clock with four
workers: AddSwipeNoReload 16s, DeleteToolCalls 13s, WorldInfoRename* 13s and 14s, MacroStoryString 13s,
MacrosParser 19s, QuickReplyOverwriteCancel 20s — about 95 seconds together after one browser boot. The
macro-heavy files measure 124s to 209s each and three exceeded 240s. A per-PR subset drawn from the fast
files plus one deep file, with the full suite nightly, is supported by these numbers rather than by estimate.

| spec | status | failure mode |
| --- | --- | --- |
| AddSwipeNoReload.e2e.js — adds swipes in place without reloading the chat | passed | passed |
| DeleteToolCalls.e2e.js — deletes preceding tool calls unless explicitly disabled | passed | passed |
| MacroEngine.e2e.js — (whole file) | hung | hung: the frontend never settled (killed at the file timeout) |
| MacroEnvBuilder.e2e.js — accepts handler functions for dynamic macros | passed | passed |
| MacroEnvBuilder.e2e.js — accepts MacroDefinitionOptions objects for dynamic macros | passed | passed |
| MacroEnvBuilder.e2e.js — accepts string values for dynamic macros | timedOut | timeout (frontend did not reach the state the spec waits for) |
| MacroEnvBuilder.e2e.js — applies providers in the expected order buckets | passed | passed |
| MacroEnvBuilder.e2e.js — builds names from overrides without relying on globals | timedOut | timeout (frontend did not reach the state the spec waits for) |
| MacroEnvBuilder.e2e.js — does not expose original helper when original is not a string | passed | passed |
| MacroEnvBuilder.e2e.js — does not populate character fields when replaceCharacterCard is false | timedOut | timeout (frontend did not reach the state the spec waits for) |
| MacroEnvBuilder.e2e.js — falls back to global name1/name2 when overrides are not provided | timedOut | timeout (frontend did not reach the state the spec waits for) |
| MacroEnvBuilder.e2e.js — handles null dynamicMacros gracefully | timedOut | timeout (frontend did not reach the state the spec waits for) |
| MacroEnvBuilder.e2e.js — handles undefined dynamicMacros gracefully | timedOut | other |
| MacroEnvBuilder.e2e.js — ignores provider errors without breaking env construction | passed | passed |
| MacroEnvBuilder.e2e.js — merges dynamicMacros properties into env.dynamicMacros | passed | passed |
| MacroEnvBuilder.e2e.js — normalizes dynamic macro keys to lowercase | passed | passed |
| MacroEnvBuilder.e2e.js — populates character fields when replaceCharacterCard is true | timedOut | timeout (frontend did not reach the state the spec waits for) |
| MacroEnvBuilder.e2e.js — sets system.model field from getGeneratingModel helper | passed | passed |
| MacroEnvBuilder.e2e.js — supports mixed dynamic macro value types | timedOut | timeout (frontend did not reach the state the spec waits for) |
| MacroEnvBuilder.e2e.js — uses groupOverride string for all group-related name fields | passed | passed |
| MacroEnvBuilder.e2e.js — uses solo-chat semantics when no group is selected | passed | passed |
| MacroEnvBuilder.e2e.js — wraps original string into a one-shot helper function | passed | passed |
| MacroLexer.e2e.js — (whole file) | hung | hung: the frontend never settled (killed at the file timeout) |
| MacroParser.e2e.js — [Error] for testing purposes, macros need to start at the beginning of the string | passed | passed |
| MacroParser.e2e.js — [Error] should throw an error for empty macro | passed | passed |
| MacroParser.e2e.js — [Error] should throw an error for incomplete macro | passed | passed |
| MacroParser.e2e.js — [Error] should throw an error for invalid identifier | passed | passed |
| MacroParser.e2e.js — [Error] should throw when there is a macro inside an identifier | passed | passed |
| MacroParser.e2e.js — [Error] should throw when there is a nested macro instead of an identifier | passed | passed |
| MacroParser.e2e.js — should allow legacy setvar with empty value argument | passed | passed |
| MacroParser.e2e.js — should generally handle whitespaces | passed | passed |
| MacroParser.e2e.js — should parse a simple macro | passed | passed |
| MacroParser.e2e.js — should parse comment macro starting with flags | passed | passed |
| MacroParser.e2e.js — should parse comment macro with special characters | passed | passed |
| MacroParser.e2e.js — should parse comment macro with whitespace | passed | passed |
| MacroParser.e2e.js — should parse comment macro without whitespace | passed | passed |
| MacroParser.e2e.js — should parse double-colon with an empty argument value | passed | passed |
| MacroParser.e2e.js — should parse global variable decrement shorthand | passed | passed |
| MacroParser.e2e.js — should parse global variable shorthand | passed | passed |
| MacroParser.e2e.js — should parse legacy banned macro with quoted argument | passed | passed |
| MacroParser.e2e.js — should parse legacy comment macro | passed | passed |
| MacroParser.e2e.js — should parse legacy datetime format macro | passed | passed |
| MacroParser.e2e.js — should parse legacy macro with empty quoted argument | passed | passed |
| MacroParser.e2e.js — should parse legacy roll macro with explicit colon separator | passed | passed |
| MacroParser.e2e.js — should parse legacy roll macro with numeric argument | passed | passed |
| MacroParser.e2e.js — should parse legacy roll macro with whitespace separator | passed | passed |
| MacroParser.e2e.js — should parse legacy single colon argument that allows double colons inside the argument | passed | passed |
| MacroParser.e2e.js — should parse local variable shorthand | passed | passed |
| MacroParser.e2e.js — should parse macro with closing block flag | passed | passed |
| MacroParser.e2e.js — should parse macro with delayed flag | passed | passed |
| MacroParser.e2e.js — should parse macro with filter flag | passed | passed |
| MacroParser.e2e.js — should parse macro with flag and arguments | passed | passed |
| MacroParser.e2e.js — should parse macro with flags and whitespace | passed | passed |
| MacroParser.e2e.js — should parse macro with legacy hash flag | passed | passed |
| MacroParser.e2e.js — should parse macro with multiple flags | passed | passed |
| MacroParser.e2e.js — should parse macro with single flag | passed | passed |
| MacroParser.e2e.js — should parse macros with double-colon argument | passed | passed |
| MacroParser.e2e.js — should parse macros with multiple double-colon arguments | passed | passed |
| MacroParser.e2e.js — should parse macros with single colon argument | passed | passed |
| MacroParser.e2e.js — should parse multiline comments | passed | passed |
| MacroParser.e2e.js — should parse nested macro in variable value | passed | passed |
| MacroParser.e2e.js — should parse nested macros inside arguments | passed | passed |
| MacroParser.e2e.js — should parse reverse legacy macro with colon argument | passed | passed |
| MacroParser.e2e.js — should parse two nested macros next to each other inside an argument | passed | passed |
| MacroParser.e2e.js — should parse variable add shorthand | passed | passed |
| MacroParser.e2e.js — should parse variable increment shorthand | passed | passed |
| MacroParser.e2e.js — should parse variable set shorthand | passed | passed |
| MacroParser.e2e.js — should parse variable shorthand with whitespace | passed | passed |
| MacroParser.e2e.js — should parse variable with hyphen in name | passed | passed |
| MacroParser.e2e.js — should strip spaces around arguments | passed | passed |
| MacroParser.e2e.js — should treat single colons as part of the argument even with colon separator | passed | passed |
| MacroParser.e2e.js — should treat single colons as part of the argument with double-colon separator | passed | passed |
| MacroRegistry.e2e.js — (whole file) | hung | hung: the frontend never settled (killed at the file timeout) |
| MacroSlashCommands.e2e.js — should bypass REPLACE_GETVAR | timedOut | timeout (frontend did not reach the state the spec waits for) |
| MacroSlashCommands.e2e.js — should not fail on out-of-bounds variable index | passed | passed |
| MacroSlashCommands.e2e.js — should not fail on unknown variable keys | passed | passed |
| MacroSlashCommands.e2e.js — should support {{arg}} macro with closure value | failed | assertion mismatch |
| MacroSlashCommands.e2e.js — should support {{arg}} macro with plain value | failed | assertion mismatch |
| MacroSlashCommands.e2e.js — should support {{pipe}} macro | timedOut | timeout (frontend did not reach the state the spec waits for) |
| MacroSlashCommands.e2e.js — should support {{timesIndex}} in /times command | passed | passed |
| MacroSlashCommands.e2e.js — should support {{var::key::index}} macro | timedOut | timeout (frontend did not reach the state the spec waits for) |
| MacroSlashCommands.e2e.js — should support {{var::key}} macro | timedOut | timeout (frontend did not reach the state the spec waits for) |
| MacroSlashCommands.e2e.js — should support custom SlashCommandScope macros | passed | passed |
| MacroSlashCommands.e2e.js — should support mixed type {{arg}} macro values | failed | assertion mismatch |
| MacroSlashCommands.e2e.js — should support wildcard {{arg}} macro | failed | assertion mismatch |
| MacrosParser.e2e.js — should resolve macros via legacy evaluateMacros when experimental engine is disabled | passed | passed |
| MacrosParser.e2e.js — should resolve macros via new engine when experimental engine is enabled | passed | passed |
| MacroStoryString.e2e.js — should produce equivalent story strings with new macro engine | passed | passed |
| MessageFormatter.e2e.js — should apply a registered hook and return the transformed text | passed | passed |
| MessageFormatter.e2e.js — should continue pipeline and skip a hook that throws | passed | passed |
| MessageFormatter.e2e.js — should export formatting_stage with expected keys | passed | passed |
| MessageFormatter.e2e.js — should export hook_order with expected keys | timedOut | timeout (frontend did not reach the state the spec waits for) |
| MessageFormatter.e2e.js — should expose stage and order constants on the instance | timedOut | timeout (frontend did not reach the state the spec waits for) |
| MessageFormatter.e2e.js — should ignore a hook that returns a non-string and keep the previous text | passed | passed |
| MessageFormatter.e2e.js — should inject the correct stage into the context | passed | passed |
| MessageFormatter.e2e.js — should pass an immutable frozen context to hooks | passed | passed |
| MessageFormatter.e2e.js — should return the message unchanged when no hooks are registered for a stage | passed | passed |
| MessageFormatter.e2e.js — should run hooks in ascending order within a stage | passed | passed |
| MessageFormatter.e2e.js — should successfully register a valid synchronous hook | passed | passed |
| MessageFormatter.e2e.js — should throw RangeError when registering a hook with an unknown stage | passed | passed |
| MessageFormatter.e2e.js — should throw TypeError when registering a non-function hook | timedOut | other |
| MessageFormatter.e2e.js — should throw TypeError when registering an async hook | passed | passed |
| MessageFormatter.e2e.js — should warn and keep text when a hook returns a Promise (simulated async escape) | passed | passed |
| QuickReplyOverwriteCancel.e2e.js — should keep the existing set when create overwrite is cancelled | passed | passed |
| QuickReplyOverwriteCancel.e2e.js — should keep the existing set when import overwrite is cancelled | passed | passed |
| ReasoningHiddenBlocks.e2e.js — close all collapses stale open hidden-like reasoning details | timedOut | timeout (frontend did not reach the state the spec waits for) |
| ReasoningHiddenBlocks.e2e.js — collapses reasoning after changing whitespace-only reasoning to different whitespace | failed | assertion mismatch |
| ReasoningHiddenBlocks.e2e.js — collapses whitespace-only reasoning after canceling edit with show hidden enabled | passed | passed |
| ReasoningHiddenBlocks.e2e.js — collapses whitespace-only reasoning after canceling message edit with reasoning edit open | passed | passed |
| ReasoningHiddenBlocks.e2e.js — collapses whitespace-only reasoning after confirming edit with show hidden enabled | passed | passed |
| ReasoningHiddenBlocks.e2e.js — collapses whitespace-only reasoning after confirming message edit with reasoning edit open | failed | assertion mismatch |
| ReasoningHiddenBlocks.e2e.js — does not create duplicate reasoning editors when add is clicked repeatedly | timedOut | timeout (frontend did not reach the state the spec waits for) |
| ReasoningHiddenBlocks.e2e.js — does not expand whitespace-only reasoning through slash commands | passed | passed |
| ReasoningHiddenBlocks.e2e.js — expands visible reasoning through slash commands | passed | passed |
| ReasoningHiddenBlocks.e2e.js — hides add reasoning button while hidden-like reasoning is being edited | timedOut | other |
| ReasoningHiddenBlocks.e2e.js — keeps reasoning expanded after changing whitespace-only reasoning to visible content | failed | assertion mismatch |
| ReasoningHiddenBlocks.e2e.js — keeps unrelated hidden reasoning blocks hidden while another block is being edited | timedOut | timeout (frontend did not reach the state the spec waits for) |
| ReasoningHiddenBlocks.e2e.js — keeps whitespace-only reasoning collapsed when auto-expand is enabled | passed | passed |
| ReasoningHiddenBlocks.e2e.js — treats whitespace-only reasoning as hidden-like when trim spaces is disabled | passed | passed |
| WorldInfoRenameChatLore.e2e.js — should retarget chat lore metadata after lorebook rename | passed | passed |
| WorldInfoRenamePersonaLore.e2e.js — should retarget persona lore metadata after lorebook rename | passed | passed |

## Failure modes

- passed: 92
- timeout (frontend did not reach the state the spec waits for): 16
- assertion mismatch: 7
- hung: the frontend never settled (killed at the file timeout): 3
- other: 3

## Raw first error per failing spec

### MacroEngine.e2e.js — (whole file)
```
file did not finish within 240000ms and was killed: the frontend did not settle, so its specs could not be measured
```

### MacroEnvBuilder.e2e.js — accepts string values for dynamic macros
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  3 |
  4 | test.describe('MacroEnvBuilder', () => {
> 5 |     test.beforeEach(testSetup.awaitST);
    |          ^
```

### MacroEnvBuilder.e2e.js — builds names from overrides without relying on globals
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  3 |
  4 | test.describe('MacroEnvBuilder', () => {
> 5 |     test.beforeEach(testSetup.awaitST);
    |          ^
```

### MacroEnvBuilder.e2e.js — does not populate character fields when replaceCharacterCard is false
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  3 |
  4 | test.describe('MacroEnvBuilder', () => {
> 5 |     test.beforeEach(testSetup.awaitST);
    |          ^
```

### MacroEnvBuilder.e2e.js — falls back to global name1/name2 when overrides are not provided
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  3 |
  4 | test.describe('MacroEnvBuilder', () => {
> 5 |     test.beforeEach(testSetup.awaitST);
    |          ^
```

### MacroEnvBuilder.e2e.js — handles null dynamicMacros gracefully
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  3 |
  4 | test.describe('MacroEnvBuilder', () => {
> 5 |     test.beforeEach(testSetup.awaitST);
    |          ^
```

### MacroEnvBuilder.e2e.js — handles undefined dynamicMacros gracefully
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  3 |
  4 | test.describe('MacroEnvBuilder', () => {
> 5 |     test.beforeEach(testSetup.awaitST);
    |          ^
```

### MacroEnvBuilder.e2e.js — populates character fields when replaceCharacterCard is true
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  3 |
  4 | test.describe('MacroEnvBuilder', () => {
> 5 |     test.beforeEach(testSetup.awaitST);
    |          ^
```

### MacroEnvBuilder.e2e.js — supports mixed dynamic macro value types
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  3 |
  4 | test.describe('MacroEnvBuilder', () => {
> 5 |     test.beforeEach(testSetup.awaitST);
    |          ^
```

### MacroLexer.e2e.js — (whole file)
```
file did not finish within 240000ms and was killed: the frontend did not settle, so its specs could not be measured
```

### MacroRegistry.e2e.js — (whole file)
```
file did not finish within 240000ms and was killed: the frontend did not settle, so its specs could not be measured
```

### MacroSlashCommands.e2e.js — should bypass REPLACE_GETVAR
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  3 |
  4 | test.describe('MacroSlashCommands', () => {
> 5 |     test.beforeEach(testSetup.awaitST);
    |          ^
```

### MacroSlashCommands.e2e.js — should support {{arg}} macro with closure value
```
Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"[Closure]"[39m
Received: [31mundefined[39m

  112 |             });
```

### MacroSlashCommands.e2e.js — should support {{arg}} macro with plain value
```
Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"world"[39m
Received: [31mundefined[39m

   99 |             });
```

### MacroSlashCommands.e2e.js — should support {{pipe}} macro
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  3 |
  4 | test.describe('MacroSlashCommands', () => {
> 5 |     test.beforeEach(testSetup.awaitST);
    |          ^
```

### MacroSlashCommands.e2e.js — should support {{var::key::index}} macro
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  3 |
  4 | test.describe('MacroSlashCommands', () => {
> 5 |     test.beforeEach(testSetup.awaitST);
    |          ^
```

### MacroSlashCommands.e2e.js — should support {{var::key}} macro
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  3 |
  4 | test.describe('MacroSlashCommands', () => {
> 5 |     test.beforeEach(testSetup.awaitST);
    |          ^
```

### MacroSlashCommands.e2e.js — should support mixed type {{arg}} macro values
```
Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"simple and ,[Closure]"[39m
Received: [31mundefined[39m

  125 |             });
```

### MacroSlashCommands.e2e.js — should support wildcard {{arg}} macro
```
Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

Expected: [32m"wildcard"[39m
Received: [31mundefined[39m

  138 |             });
```

### MessageFormatter.e2e.js — should export hook_order with expected keys
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

   9 |     // message-formatter.js imports script.js, which requires the full ST module
  10 |     // graph to be settled before dynamic import works (otherwise hits SlashCommandParser TDZ).
> 11 |     test.beforeEach(testSetup.awaitST);
     |          ^
```

### MessageFormatter.e2e.js — should expose stage and order constants on the instance
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

   9 |     // message-formatter.js imports script.js, which requires the full ST module
  10 |     // graph to be settled before dynamic import works (otherwise hits SlashCommandParser TDZ).
> 11 |     test.beforeEach(testSetup.awaitST);
     |          ^
```

### MessageFormatter.e2e.js — should throw TypeError when registering a non-function hook
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

   9 |     // message-formatter.js imports script.js, which requires the full ST module
  10 |     // graph to be settled before dynamic import works (otherwise hits SlashCommandParser TDZ).
> 11 |     test.beforeEach(testSetup.awaitST);
     |          ^
```

### ReasoningHiddenBlocks.e2e.js — close all collapses stale open hidden-like reasoning details
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  46 |
  47 | test.describe('Reasoning hidden blocks', () => {
> 48 |     test.beforeEach(testSetup.awaitST);
     |          ^
```

### ReasoningHiddenBlocks.e2e.js — collapses reasoning after changing whitespace-only reasoning to different whitespace
```
Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBeNull[2m()[22m

Received: [31m"true"[39m

  736 |
  737 |         expect(result.textareaCount).toBe(0);
```

### ReasoningHiddenBlocks.e2e.js — collapses whitespace-only reasoning after confirming message edit with reasoning edit open
```
Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoBe[2m([22m[32mexpected[39m[2m) // Object.is equality[22m

[32m- Expected  - 2[39m
[31m+ Received  + 1[39m

[32m-[39m
```

### ReasoningHiddenBlocks.e2e.js — does not create duplicate reasoning editors when add is clicked repeatedly
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  46 |
  47 | test.describe('Reasoning hidden blocks', () => {
> 48 |     test.beforeEach(testSetup.awaitST);
     |          ^
```

### ReasoningHiddenBlocks.e2e.js — hides add reasoning button while hidden-like reasoning is being edited
```
[31mTest timeout of 30000ms exceeded.[39m
```

### ReasoningHiddenBlocks.e2e.js — keeps reasoning expanded after changing whitespace-only reasoning to visible content
```
Error: [2mexpect([22m[31mreceived[39m[2m).[22mtoContain[2m([22m[32mexpected[39m[2m) // indexOf[22m

Expected substring: [32m"visible reasoning"[39m
Received string:    [31m"undefined"[39m

  701 |         expect(result.hasContent).toBe('true');
```

### ReasoningHiddenBlocks.e2e.js — keeps unrelated hidden reasoning blocks hidden while another block is being edited
```
[31mTest timeout of 30000ms exceeded while running "beforeEach" hook.[39m

  46 |
  47 | test.describe('Reasoning hidden blocks', () => {
> 48 |     test.beforeEach(testSetup.awaitST);
     |          ^
```

## Generation probe (increment 0b): NO, and the reason

One question: does a send driven from the pinned frontend produce a provider request at all?
`tests/browser/generation-probe.mjs` boots GoTavern and the recording mock provider, drives one
generation from the page (temporary assistant chat, `chat_completion_source = 'custom'`, custom URL
pointing at the mock), then polls `GET /__mock/recording`.

ANSWER: **no provider request arrives.** The probe reports `requestArrived: false`, and the traced
HTTP failures say why:

```
404 POST /api/secrets/read
404 POST /api/horde/status
404 POST /api/horde/text-models
404 GET  /thumbnail
404 GET  /backgrounds/__transparent.png
FAILED GET /css/user.css, POST /api/ping (aborted during teardown)
```

`POST /api/secrets/read` is the blocking one. The pinned frontend populates `secret_state` from that
route at startup (`public/scripts/secrets.js`, consumed by `public/scripts/openai.js`), and GoTavern
does not implement the secrets domain at all: there is no `/api/secrets/*` registration anywhere in
`internal/server`. The page surfaces the consequence as `Unexpected token '<', "<!DOCTYPE "...`, i.e.
the 404 HTML page being parsed as JSON by the frontend.

WHAT THIS MEANS FOR ORDERING: the tokenizer boundary spec cannot be written yet, and neither can the
provider-request leg of T3 or rule 15's canary assertion, because all three assume a send produces a
provider request. That assumption is now measured and false for the current tree. The next increment
in this domain is not a tokenizer increment at all: it is `/api/secrets/read` (and whatever else the
frontend needs on the settings/startup path), after which this probe is the cheapest possible
re-check — it takes one command and answers the same binary question.

WHAT THIS PROBE DOES NOT CLAIM: nothing about prompt assembly, token budgets, or the provider request's
shape. It reports only whether a request arrives, because building the boundary assertion on top of a
send path that does not complete would have hidden this finding inside a larger failure.

Reproduce with: `node tests/browser/generation-probe.mjs` (it builds the binary and the mock provider,
so it needs no running services).

## The capture instrument: a settings state that is real, and the trap that hid it

The send leg needs a configuration that a real user could produce. `tests/browser/capture-settings.mjs`
produces one by driving the pinned frontend's own panel controls, and
`tests/browser/run-against-pinned.mjs` gives it a clean pinned server per run (free port, scratch data
root, readiness from `/version`, teardown in `finally`). A fresh data root boots with no stdin
interaction; it seeds `default/**` and compiles the frontend libraries, which costs 20-40 s.

The fixture it writes, `tests/browser/fixtures/custom-source-settings.json`, now ends on
`chat_completion_source = "custom"`, `custom_model = "probe-model"`, `custom_url = "http://127.0.0.1:1"`
and 106 `oai_settings` keys. Two consecutive runs are byte-identical apart from the `capturedAt`
provenance field, and the server's per-run port is normalized to `:<port>` so a re-capture does not
differ for a reason that says nothing about the frontend. With `CAPTURE_TIMESTAMP` set, a re-capture is
byte-identical to the committed fixture (verified by digest), which is what makes "did the frontend
change?" answerable from a diff rather than from a normalized comparison.

THE TRAP, MEASURED RATHER THAN REASONED ABOUT. Setting the source to `custom` appeared to work and then
silently stopped working: a capture that checked the value once recorded `custom`, and the very next
read of the same field in the same synchronous continuation saw `openai`. Wrapping the field in an
accessor that records each write with a stack named the culprit instead of leaving it to speculation:

```
custom   openai.js:6970  <- HTMLSelectElement change handler (the write we made)
openai   openai.js:5063  <- 225 ms later, from the preset-change continuation
```

`oai_preset_changed` (public/scripts/openai.js:5034) awaits `OAI_PRESET_CHANGED_BEFORE` and only then
writes every connection setting, including `chat_completion_source`, and then re-triggers the source's
own `change` handler (5069) when `bind_preset_to_connection` is set. So the preset is not finished when
the setting appears; it is finished when its promise resolves, and the frontend exposes exactly that as
`getPresetApplicationPromise()` (openai.js:5015). The capture awaits it, and then requires the source to
be STABLE across a 500 ms window rather than momentarily correct. This is the general form of the
lesson: for an asynchronous UI handler, "true right now" and "will stay true" are different
propositions, and a capture that only asserts the first records a state the user never had.

A second, cheaper defect in the same script: it drove `#custom_model`, which is not in the DOM at all.
The model binding is `custom_model: ['#custom_model_id', 'custom_model', false, true]` (openai.js:349)
and its event is `input` (openai.js:5620). The absence of the element was reported as "the custom model
input is not present after selecting the custom source", which read like a frontend problem and was a
script reading a plausible-sounding id instead of the binding.

WHAT THIS DOES NOT PROVE: that the captured configuration sends. It is a faithful state, not a
successful generation -- `requestArrived` remains false in the generation probe, and the two-leg
comparison it exists for has not been run. `custom_url` points at a closed port on purpose, so the
request that should arrive is one that fails at transport; the comparison is about the attempt.

Reproduce with: `node tests/browser/run-against-pinned.mjs capture-settings.mjs`.

## The send leg: still no provider request, and now provably the DRIVER's fault

With a faithful settings state the generation probe still reported `requestArrived: false`. The
important result of this increment is not the negative: it is that the SAME drive against PINNED NODE
fails the same way, which moves the finding from the product to the probe (verification rule 10, first
case) and retires a question that had been standing as a possible GoTavern defect.

```
                          GoTavern          pinned Node 1.19.0
requests recorded            251                    391
tokenizer count calls         13                     14
POST /api/backends/...    ABSENT                 ABSENT
GENERATE_AFTER_DATA       reached                reached
CHAT_COMPLETION_SETTINGS_READY   never           never
provider request          none                   none
```

Three defects in the drive, each found by a measurement rather than by reading code:

1. **`main_api` was `koboldhorde`.** It is not part of `oai_settings`, and it is an exported `let`, so
   the probe's settings assignment could not set it. `sendGenerationRequest` branches on it BEFORE it
   looks at the chat-completion source (script.js:6117), so the send went down the Horde path: the
   console showed `adjustHordeGenerationParams`'s two-value log (`horde.js:148`, `8192 350`) and
   `POST /api/horde/text-workers`, and no chat-completions call was ever made. The fix drives
   `#main_api`, the control a user drives, whose change handler assigns the flag (script.js:7861).
   Measured after the fix: `diagnostics.mainApi == 'openai'`.
2. **`script.isGenerating` is not a usable gate.** It reads `true` on a freshly loaded page and
   `true` after a generation that ended, which is why the probe's precondition correctly uses
   `body[data-generating]` and the send button instead.
3. **The rule-20 window was too short.** The world-info dry run counts every candidate, and 20 s
   elapsed while token counts were still in flight. The recorder is now polled for 60 s.

Two omissions in the REPORT, both of which had produced false confidence: no `console` listener at all
(so "0 console errors" was a read of a field that did not exist), and no `toastr` reading (the
frontend reports a refused generation by toast and fires `generation_ended` with no page error). The
report now carries every console message with its type, the toast text, and the generation event trail.

WHAT STILL DOES NOT ADD UP, stated rather than papered over: the run reaches `generate_after_data` and
then stops with no fetch, no error, `generation_ended` never emitted and `CHAT_COMPLETION_SETTINGS_READY`
never emitted -- on both servers. That event is emitted at openai.js:3146, immediately before the
`fetch` to `/api/backends/chat-completions/generate`, so the hang is between the prompt being ready and
the request being issued. Ruling things OUT is cheap here and has already been done: `reverse_proxy` is
empty in the fixture, so `validateReverseProxy` (openai.js:2850) is not called; `tools` is absent, so
`registerFunctionToolsOpenAI` (2841) is not either. What remains is inside the frontend's streaming
dispatch, and one concrete suspect is that the fixture stores booleans as the STRINGS the panel writes
(`stream_openai: "True"`), so any `=== true` or `=== 'true'` comparison in that path sees a third value.
That is the next thing to measure, not something to fix by assignment.

Reproduce with:
`node tests/browser/run-against-pinned.mjs generation-probe.mjs -- --report <path>` (pinned) and
`node tests/browser/generation-probe.mjs --report <path>` (GoTavern).

