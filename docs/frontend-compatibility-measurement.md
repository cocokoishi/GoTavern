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


## 2026-10-21 — the send is drivable end to end, and the first differential names the blocker

The previous entry ended at `generate_after_data` with no request, on both servers. That is now
resolved: the same drive reaches `CHAT_COMPLETION_SETTINGS_READY` and `GENERATION_ENDED` and the mock
provider records `POST /chat/completions` on BOTH legs. The earlier stop was a DRIVER defect, and it
was three defects, each measured before it was fixed (no production code changed):

1. FIRST-RUN ONBOARDING WAS NEVER COMPLETED. A fresh data root has `settings.firstRun = true`, and
   `getSettings()` AWAITS `doOnboarding()` (script.js:8041), a user-input popup. Until it is completed
   `settingsReady` stays false, `saveSettings` only logs "Settings not ready, scheduling another save",
   and PromptManager's `saveServiceSettings` waits for a `SETTINGS_UPDATED` a gated save never emits.
   Measured: `settingsReady` never became true in 60 s; the welcome popup was present. The drive now
   fills the name and presses OK, exactly as a first-run user does.
2. THE CONNECT STEP WAS MISSING. `Generate()` returns silently when `online_status` is
   `'no_connection'` (script.js:4391), before the composer is touched. `online_status` is only set by
   the frontend's own connection check, triggered by the Connect control the user presses after
   entering the endpoint and key. Measured without it: real `GENERATION_STARTED` and
   `GENERATION_AFTER_COMMANDS` only, composer still full, no user message appended, no request. With
   a press on `#api_button_openai` and a wait for a non-`no_connection` status: the whole path runs.
3. THE PROBE READ RESPONSE BODIES IT SHOULD NOT. The fetch wrapper read `clone().text()` for every
   response; `POST /api/ping` (204) was traced and the wrapper was a suspect, so a no-`204` guard was
   added. Keeping the trace is what proved the ping itself returns 204 and is not the blocker.

The same drive therefore now produces two comparable legs. They are deterministic individually
(GoTavern POST body SHA-256 `f27ce88c…f2896c` on two runs; pinned `d644f007…e259c23` on two runs), but
THEY ARE NOT EQUAL, and the difference is a GoTavern finding, not fixture noise:

- The provider request bodies differ only in `messages[1]` (the example-dialogue entry): GoTavern
  6678 bytes, pinned 7400 bytes; all five other messages are byte-identical.
- The cause is the tokenizer endpoint. The frontend asks both servers to count the same strings
  (jQuery XHR, captured by patching XMLHttpRequest), and the answers differ: `"probe user marker"`
  -> 15/10 on GoTavern vs 10/9 on pinned; `*You wake with a start…` -> 242 vs 190;
  `Probe User: "What is Eldoria?"` -> 477 vs 380. That changes how much example dialogue fits and
  therefore which example is sent.
- The same route's RESPONSE SHAPE differs: for `"Seraphina"` GoTavern answers
  `{"ids":[],"count":3}`, pinned answers `{"ids":[1816,12451,1099],"count":3}`. The ids array is
  empty in GoTavern and populated in pinned.
- A second, independent parity gap: during Connect, pinned's `/api/backends/chat-completions/status`
  forwards a `GET {custom_url}/models` to the provider; GoTavern's leg sends no such request, yet the
  browser still reports a connected state.
- Observed but unexplained: the pinned leg shows one extra prompt-manager dry generation, and the
  post-send chat length was 3 on GoTavern vs 2 on pinned in the same capture.

Next concrete step (do not touch the probe further to chase it): fix `/api/tokenizers/openai/count`
parity — the populated `ids` array and the counts themselves — then rerun
`compare-generation-legs.mjs`; `providerRequestEqual` is the acceptance signal. Independently, add
the custom-source `/models` forward to the chat-completions status route and assert it as a request,
not as a status code.

Reproduce both legs (deterministic, ~3 min each on this machine):

    node tests/browser/generation-probe.mjs --report tests/browser/gen-a.json
    node tests/browser/run-against-pinned.mjs generation-probe.mjs -- --report <absolute-path>/gen-p1.json
    node tests/browser/compare-generation-legs.mjs tests/browser/gen-a.json tests/browser/gen-p1.json

`generation-comparison.json` is the machine-readable comparison of those two captures
(`requestArrived` both true, `providerRequestEqual` false, `milestoneEqual` false, one body
difference).

## 2026-10-21 — streaming and cancellation proven on both legs; five surfaces now have artifacts

The missing fifth observer surface is closed. `tests/browser/streaming-comparison.json` records three
paired drives (stream answered, cancelled mid-stream, genuine non-stream control) and its own verdict:
`compatibleReady: true` — all checks hold on BOTH GoTavern and pinned.

MEASURED (canonical captures under `tests/browser/`):
- STREAMED: both legs send `POST /chat/completions` 7400 bytes SHA-256 `d644f007…e259c23`
  (`stream: true`), the peer writes 9 chunked SSE frames, the browser renders 9 distinct incremental
  text states with an IDENTICAL ordered sequence (`Hello from` -> `Hello from the` -> … -> final),
  final text equal, no page errors.
- CANCELLED: both legs send the same 7400-byte streamed request, the browser presses the frontend's
  own Abort control (#mes_stop) after `Hello from` has rendered, the peer records
  `clientDisconnected: true` on BOTH legs, both retain the partial text `Hello from` as the final
  message, and the text is unchanged 1.2 s and 2.7 s after the abort (no further chunks applied).
  The peer wrote 12 paced frames before noticing the close; frame count is timing, not behaviour.
- NON-STREAM CONTROL: both legs send `stream: false` (7401 bytes SHA-256 `f6aba6d6…`) and settle on
  one assistant content state (`probe reply`), proving the streaming above is not the only path.

THREE PROBE DEFECTS were found and fixed while getting here (all rule-10 classes, none a product
difference — each was proven to affect both legs identically before being fixed):
1. The probe's fetch wrapper awaited `response.clone().text()` for EVERY response before returning it
   to the frontend. A streamed generate response was therefore fully buffered before its fetch
   promise resolved: incremental rendering was impossible to observe, and an aborted stream observed
   an empty message. Every earlier capture in this directory had that defect — the "non-streaming"
   captures actually sent `stream: true` (their body SHA is the streamed one) and only appeared
   incremental-free. Fixed by skipping the clone read for `text/event-stream` and for the generate
   route.
2. The sequential Go mock script answered the FIRST request. Once the Connect step was added, the
   chat-completions status route's `GET /models` consumed the only scripted response and the
   completion POST got the mock's default 500 on BOTH legs. Fixed with two scripted responses
   (models, then completion); the non-stream control validates the corrected script.
3. Aborting "after N render snapshots" is a race between provider writes and browser rendering: an
   early abort made GoTavern retain "Hello" while pinned cleared the placeholder to "". The abort
   point is now an EXACT rendered prefix (`Hello from`), a state both legs reach; after that both
   legs agree (partial text retained). The earlier divergence is recorded here as probe timing, not
   as a compatibility gap.

ARTIFACTS FOR THE FIVE SURFACES (chat-completions generation path, custom/OpenAI-compatible source):
1. browser -> server HTTP: the route replays against pinned fixtures (`sillytavern-1.19.0-backends.json`,
   `…-provider-wire.json`), plus the browser request log in the captures above.
2. server -> provider wire: `tests/browser/generation-comparison.json` `providerRequestEqual: true`
   (7400 bytes, SHA-256 `d644f007…`); this entry adds the streamed request with the same bytes.
3. filesystem / startup: startup and data-domain fixtures; the drive adds no writes.
4. browser events / final state: `generation-comparison.json` event trail; `streaming-comparison.json`
   records final text and the abort end state.
5. streaming and cancellation: `tests/browser/streaming-comparison.json` (streaming, cancellation and
   non-stream sections; `compatibleReady: true`).

SCOPE, stated plainly: the differential covers the custom/OpenAI-compatible source end to end. Other
sources have their own provider-wire fixtures but were not driven through the browser in this
increment, so any `compatible` row should name the custom-source generation path rather than imply
every source was browser-proven.

Reproduce (each capture is ~1–2 min; pinned legs need the harness):
    PROBE_MODE=stream PROBE_FRAME_COUNT=8 PROBE_FRAME_MS=300 node tests/browser/generation-probe.mjs --report tests/browser/stream-gotavern.json
    PROBE_MODE=stream PROBE_FRAME_COUNT=8 PROBE_FRAME_MS=300 node tests/browser/run-against-pinned.mjs generation-probe.mjs -- --report <absolute path>/stream-pinned.json
    PROBE_MODE=cancel PROBE_FRAME_MS=300 node tests/browser/generation-probe.mjs --report tests/browser/cancel-gotavern.json
    PROBE_MODE=cancel PROBE_FRAME_MS=300 node tests/browser/run-against-pinned.mjs generation-probe.mjs -- --report <absolute path>/cancel-pinned.json
    node tests/browser/generation-probe.mjs --report tests/browser/nonstream-gotavern.json
    node tests/browser/run-against-pinned.mjs generation-probe.mjs -- --report <absolute path>/nonstream-pinned.json
    node tests/browser/compare-streaming-legs.mjs stream-gotavern.json stream-pinned.json cancel-gotavern.json cancel-pinned.json nonstream-gotavern.json nonstream-pinned.json
## 2026-10-21 — browser-events surface for the startup and data domains, measured on both legs

`tests/browser/startup-comparison.json` is the two-leg differential for the requests the pinned
frontend makes at boot. The drive completes first-run onboarding, selects `#main_api`, awaits
`settingsReady`, configures the custom source and presses Connect; the report's `reachedUserState`
asserts each of those and the comparison refuses to call the drive faithful otherwise.

RESULT: **349 equal, 4 different-status, 0 missing-on-gotavern, 0 extra-on-gotavern,
0 different-body, 0 unexpected**. Final page state is equal across every compared field (settings
readiness, online status, character rows, main API value, send button presence/disabled, top bar, API
panel, toast text, generating attribute, title, extension panel count, prompt manager, character list,
quick replies). The four non-equal rows are ALL KNOWN, none unexpected:
- `GET /thumbnail?type=avatar&file=default_Seraphina.png` 404 vs 200, and the persona thumbnail — the
  `/thumbnail/<computed: Identifier>` route is `not implemented` in `docs/api-inventory.md`;
- `GET /backgrounds/__transparent.png` 404 vs 200 and `GET /css/user.css` no-response vs 200 — both
  classified `cosmetic` in `docs/frontend-startup-calls.md`.

PROBE FAITHFULNESS, including the two suspects named before starting:
- `startup-calls.mjs` does NOT have the generation probe's unconditional `clone().text()` defect: it
  reads response bodies through Playwright's `response` object and never replaces the page's fetch.
  The new differential uses the same mechanism, so streamed/buffered response bodies cannot be
  conflated here.
- The drive reached a real user state (onboarding completed, settingsReady true, Connect pressed, the
  `POST /api/backends/chat-completions/status` request observed) on ALL FOUR captures. An early
  version sampled the onboarding popup once immediately after the preloader disappeared and flaked
  once into `settingsReady: false`; it now WAITS for the popup or readiness, which is what a user
  does.
- RELEASE-LAYOUT staging matters and has two failure modes, both measured: staging only `tokenizers/`
  made the static/extension surface look missing (including `/api/extensions/discover` returning
  `[]`), so the drive now also stages the built-in extensions subtree at
  `<InstallRoot>/public/scripts/extensions`; staging the whole vendored `upstream/public` is WRONG —
  that is the pinned SOURCE tree, and serving its index.html produced `Failed to resolve module
  specifier "lodash"` because a release serves the GENERATED public bundle. Extensions only.
- Response bodies are compared only where TWO RUNS OF EACH LEG produce the same digest; a body that
  varies between two identical drives is recorded as `shape` with that reason. Repeat counts per
  method+path vary with render/poll timing and are recorded, not asserted.

PROPOSED `docs/surface-coverage.md` updates (not applied): the artifact is browser-event evidence for
the startup scenario only. It can give E to a new **Startup / boot sequence** row and to the
**Secrets** row (`/api/secrets/read` and `/api/secrets/write` were observed equal), and it supports E
for startup-scenario coverage of characters (`/api/characters/all`), chats (`/api/chats/recent`,
`get`, `save`), backgrounds (`/api/backgrounds/all`, `folders`), extensions (`discover` plus the
built-in extension files), quick replies (`save`) and SD workflows (`/api/sd/comfy/workflows`) —
provided those rows say "startup scenario" rather than implying every operation in the area was
driven. The thumbnail gaps are inventory `not implemented`, not E evidence for the assets domain.

## 2026-10-21 (later) -- the dryAfterData divergence RESOLVED as a recording window, not a product difference

The entry above recorded "one extra prompt-manager dry generation" on the pinned leg and left it
unexplained. It is now measured and closed, and the answer was the observation window.

- The ONLY emitter of `GENERATE_AFTER_DATA` is `script.js:5318`, inside `Generate`. `:4299` emits
  `GENERATION_STARTED` unconditionally before any branch, and `:5320-5322` returns early for a dry run,
  so a dry generation emits AFTER_DATA and never `GENERATION_ENDED`. The dry path is
  `PromptManager.js:862-872` -> `openai.js:707-713` -> `Generate('normal', {}, true)`; the drive's own
  source/model selection triggers one before the send, and `MESSAGE_RECEIVED` triggers one after it.
- The superseded pinned leg recorded dry `GENERATION_STARTED 1` against dry `GENERATE_AFTER_DATA 2`,
  which is impossible for a window that begins before the invocation it contains. The window had opened
  a few statements before the send click, while the pre-send dry run was still running.
- Both legs' own frontend logs recorded the SAME whole-drive count: `Generate entered` x3 and
  `calling runGenerate` x3 in the earlier pair, and 4 invocations (3 dry + 1 real) in the final pair.
  The 1-vs-2 asymmetry also moved to whichever leg was slower across the gen, cancel, stream and
  non-stream pairs, which a server property cannot do.
- The superseded artifact also described a send that never completed: both legs recorded
  `500 POST /api/backends/chat-completions/generate` and `pageErrors: ["Got response status 500"]`,
  because the drive kept `stream_openai` true while the mock answers one non-SSE JSON body. The send in
  `generation-comparison.json` is now the NON-STREAMED one (7401 bytes, SHA-256 f6aba6d6...) with a
  rendered reply on both legs; the streamed path is covered by `streaming-comparison.json`
  (7400 bytes, SHA-256 d644f007...), which is untouched.
- Fixes, all in the probe and the comparison: the recorder attaches at PAGE LOAD and counts in-flight
  `Generate` invocations from the pinned emitter arguments; the drive waits for QUIESCENCE before the
  send (a click mid-assembly is a state no user can act from) and closes the window at
  `GENERATION_ENDED` instead of a 3 s sleep (a second race, measured: the pinned leg had rendered the
  reply but not yet emitted the event, giving `generationEnded 0 vs 1`); excluded events are recorded
  under `surrounding` with the whole-drive count. `compare-generation-legs.mjs` exits 1 on a false
  window guard, and `tools/verify-browser-comparisons.mjs` now checks those guards in the COMMITTED
  artifact as well.
- Still unproven, and not to be repeated as fact: WHY the pinned leg is slower. It is measured only as
  aggregate weight (412 vs 279 requests in one pair), and the extension line above is now the leading
  candidate -- a release-shaped GoTavern stages built-in extensions by hand because
  `/api/extensions/discover` lists none. The pre-send dry-run count also varies 1-2 across runs on one
  leg (debounce coalescing), so it is recorded and never compared.

## Frontend connect/send contract, as read from the pinned source

Four facts govern whether a browser drive can reach a chat-completion send for a given source. Every one was
learned by a driver failing at it, and none is guessable from the server side. All line numbers are
`public/scripts/openai.js` at the pinned commit.

1. **Six sources never validate a connection.** `getStatusOpen()` (:4459) opens with
   `noValidateSources = [CLAUDE, AI21, VERTEXAI, PERPLEXITY, ZAI, MINIMAX]` and, for those, sets the online
   status to the message "Key saved; press \"Test Message\" to verify." and RETURNS before any status request.
   A drive that waits for a `connected` state before sending will hang forever on these sources, and an empty
   provider log on their status call is CORRECT rather than a misaimed peer.

2. **A reverse proxy needs a one-time confirmation dialog.** `proxySupportedSources` (:2838) does include
   CLAUDE and MISTRALAI, so `generate_data.reverse_proxy` is set whenever the setting is populated -- but
   `await validateReverseProxy()` runs first (:2849), and it (:537-563) shows `Popup.show.confirm("Connecting
   To Proxy")` unless `accountStorage` holds `Proxy_SkipConfirm_<getStringHash(url)>`. An unclicked dialog
   blocks the send BEFORE the fetch: the prompt assembles fully, no generate request is issued, and the drive
   times out with "the send did not complete and settle". That is the dialog, not a product hang.

3. **There are exactly three connect buttons.** `public/index.html` defines `api_button_novel`,
   `api_button_openai` and `api_button_textgenerationwebui`; the chat-completion sources all share
   `#api_button_openai`, so a missing status call for a per-source panel is never a wrong-button problem.

4. **The connect handler gates on a STALE secret map.** `onConnectButtonClick` (:6036) reads the key out of
   the source field, writes it, and then returns early unless `secret_state[<key>]` is truthy OR the proxy path
   applies (:6089). `secret_state` is filled ONCE at page load (`secrets.js:419`), so a secret written through
   `/api/secrets/write` AFTER load leaves the page believing nothing is saved. The user path -- type the key
   into `#api_key_<source>` and click Connect -- is the one that works, and it is also the faithful one.

Consequence for the harness: a per-source drive must type credentials through the field, handle the proxy
confirmation, accept the no-validate connect state for the six sources that have one, and drive the modal file
list. Any of those skipped produces a failure that looks like a product defect on BOTH legs -- which is the
signature to look for before suspecting the server.
