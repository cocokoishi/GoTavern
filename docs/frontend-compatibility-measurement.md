# Pinned frontend compatibility measurement (increment 0)
## Measurement status: PARTIAL, and why

This run is a partial measurement. The pinned suite is slower against a live browser than a first
reading suggests: each spec boots the page and waits for the preloader, and the macro-heavy files hold
hundreds of specs. Under a 90-second per-file budget the seven macro files were killed before they
could report, and under an earlier single 480-second global budget MacroEngine alone reported 62 passing
specs before the run was cut. So the numbers below are a floor, not a result.

Two things follow, and they belong in the harness plan rather than in this report:

1. The gate cannot run the whole pinned suite per pull request at this speed. The measured cost argues for
   a per-file budget with files run in parallel workers, and for a PR subset plus a nightly full run.
2. A file that cannot finish must be reported as hung rather than allowed to starve the rest, which is what
   the runner now does per file.

What IS measured: every spec that completed passed. Nine of the nine measured specs passed across nine
files, including chat-state manipulation (AddSwipeNoReload, DeleteToolCalls, QuickReplyOverwriteCancel),
world-info rename flows, macro story string and macros parsing. No failing spec was observed in this run;
the unmeasured files are unmeasured, not failed.


Pinned SillyTavern checkout: `C:\Users\koishi\Desktop\GoTavern\SillyTavern`
GoTavern: `gotavern start --port 56126 --dataRoot <scratch>`
Pinned suite: 17 specs, run unmodified from the checkout with Playwright pinned to 1.56.1.

This is a measurement of how much of the pinned frontend contract GoTavern satisfies today.
Expected failures are not defects: most routes are still unimplemented, and the value here is the
failure mode per spec, which is an inventory of what the frontend needs.

| spec | status | failure mode |
| --- | --- | --- |
| AddSwipeNoReload.e2e.js — adds swipes in place without reloading the chat | passed | passed |
| DeleteToolCalls.e2e.js — deletes preceding tool calls unless explicitly disabled | passed | passed |
| MacroEngine.e2e.js — (whole file) | hung | hung: the frontend never settled (killed at the file timeout) |
| MacroEnvBuilder.e2e.js — (whole file) | hung | hung: the frontend never settled (killed at the file timeout) |
| MacroLexer.e2e.js — (whole file) | hung | hung: the frontend never settled (killed at the file timeout) |
| MacroParser.e2e.js — (whole file) | hung | hung: the frontend never settled (killed at the file timeout) |
| MacroRegistry.e2e.js — (whole file) | hung | hung: the frontend never settled (killed at the file timeout) |
| MacroSlashCommands.e2e.js — (whole file) | hung | hung: the frontend never settled (killed at the file timeout) |
| MacrosParser.e2e.js — should resolve macros via legacy evaluateMacros when experimental engine is disabled | passed | passed |
| MacrosParser.e2e.js — should resolve macros via new engine when experimental engine is enabled | passed | passed |
| MacroStoryString.e2e.js — should produce equivalent story strings with new macro engine | passed | passed |
| MessageFormatter.e2e.js — (whole file) | hung | hung: the frontend never settled (killed at the file timeout) |
| QuickReplyOverwriteCancel.e2e.js — should keep the existing set when create overwrite is cancelled | passed | passed |
| QuickReplyOverwriteCancel.e2e.js — should keep the existing set when import overwrite is cancelled | passed | passed |
| ReasoningHiddenBlocks.e2e.js — (whole file) | hung | hung: the frontend never settled (killed at the file timeout) |
| WorldInfoRenameChatLore.e2e.js — should retarget chat lore metadata after lorebook rename | passed | passed |
| WorldInfoRenamePersonaLore.e2e.js — should retarget persona lore metadata after lorebook rename | passed | passed |

## Failure modes

- passed: 9
- hung: the frontend never settled (killed at the file timeout): 8

## Raw first error per failing spec

### MacroEngine.e2e.js — (whole file)
```
file did not finish within 90000ms and was killed: the frontend did not settle, so its specs could not be measured
```

### MacroEnvBuilder.e2e.js — (whole file)
```
file did not finish within 90000ms and was killed: the frontend did not settle, so its specs could not be measured
```

### MacroLexer.e2e.js — (whole file)
```
file did not finish within 90000ms and was killed: the frontend did not settle, so its specs could not be measured
```

### MacroParser.e2e.js — (whole file)
```
file did not finish within 90000ms and was killed: the frontend did not settle, so its specs could not be measured
```

### MacroRegistry.e2e.js — (whole file)
```
file did not finish within 90000ms and was killed: the frontend did not settle, so its specs could not be measured
```

### MacroSlashCommands.e2e.js — (whole file)
```
file did not finish within 90000ms and was killed: the frontend did not settle, so its specs could not be measured
```

### MessageFormatter.e2e.js — (whole file)
```
file did not finish within 90000ms and was killed: the frontend did not settle, so its specs could not be measured
```

### ReasoningHiddenBlocks.e2e.js — (whole file)
```
file did not finish within 90000ms and was killed: the frontend did not settle, so its specs could not be measured
```
