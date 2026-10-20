# Pinned tokenizer data provenance

This directory is a compatibility asset tree. It is a **release asset loaded from disk**, not an
embedded tree: `upstream/assets.go` deliberately does not embed it, so the binary carries only the
SHA-256 manifest at `upstream/manifests/tokenizers.sha256`.

Verify the tree against the manifest:

```text
go run ./tools/assetmanifest -root upstream/tokenizers -output upstream/manifests/tokenizers.sha256 -check
```

The manifest covers this file too, so editing this file requires regenerating the manifest in the same
commit. Nothing here may be loaded at startup; encodings are loaded lazily and cached per process,
mirroring the pinned `tokenizersCache`.

## 1. Files copied from the pinned SillyTavern commit

Source: `SillyTavern/SillyTavern` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`, path `src/tokenizers/`.
Licence: the repository is AGPL-3.0, the same licence as GoTavern. Upstream ships no licence file,
README or provenance notice in that directory; the recorded review is
`docs/tokenizer-parity-plan.md` §8.

| file | bytes | SHA-256 |
|---|---|---|
| `claude.json` | 1,774,213 | `c241737df24b4e7f7c9af4fdcee29a0ca903dcb288a8b753bc346a3092911767` |
| `gemma.model` | 4,241,003 | `61a7b147390c64585d6c3543dd6fc636906c9af3865a5548f27f31aee1d4c8e2` |
| `jamba.model` | 1,124,714 | `8b0df4fb43262c452ef37061951a06df4c63ca191d02a60ea08f14428af24376` |
| `llama.model` | 499,723 | `9e556afd44213b6bd1be2b850ebbbd98f5481437a8021afaf58ee7fb1818d347` |
| `llama3.json` | 6,082,250 | `7a413fb6f10a3e285a400d7cc9b8959c32116caf81ba8a60a4ec26b9aca2bd25` |
| `mistral.model` | 493,443 | `dadfd56d766715c61d2ef780a525ab43b8e6da4de6865bda3d95fdef5e134055` |
| `nerdstash.model` | 1,033,724 | `578fa0ed4d6dbee435f21d7f7a741506d09cdd93cce241008abf725407cbdb41` |
| `nerdstash_v2.model` | 1,033,744 | `005ad680b10f1abd406bdb0ca9c6a5d83fc1f6e0a855bdd1942c1ceab1fb47ab` |
| `yi.model` | 1,033,105 | `386c49cf943d71aa110361135338c50e38beeff0a66593480421f37b319e1a39` |

## 2. tiktoken rank tables

Source: npm package `tiktoken@1.0.22` (MIT), `encoders/*.json`, `model_to_encoding.json` and
`registry.json`, resolved by the pinned SillyTavern `package-lock.json`. The BPE rank data originates
from OpenAI's `tiktoken` repository (MIT).

The pinned Node oracle executes the WASM inside that same package version, which was built from these
same rank tables. These files are vendored as the pinned rank source; the differential corpus in P2 is
what proves the Go implementation agrees with the oracle, not this file.

`gpt2.json` and `r50k_base.json` are byte-identical; both are kept so the encoding names map one-to-one
onto the pinned package.

| file | bytes | SHA-256 |
|---|---|---|
| `tiktoken/gpt2.json` | 545,308 | `199cf7ee5013d4cd95015d672fdc9d9d8ebf942f69fc5ed424148add1f533493` |
| `tiktoken/r50k_base.json` | 545,308 | `199cf7ee5013d4cd95015d672fdc9d9d8ebf942f69fc5ed424148add1f533493` |
| `tiktoken/p50k_base.json` | 545,805 | `f1f1f3a216c670d53b56cd3077e16e2e60644482584521881e95996d9310034e` |
| `tiktoken/p50k_edit.json` | 545,849 | `82d4585313a5846f40c1718b7c11d837e8526267582810312720c8489d5485f1` |
| `tiktoken/cl100k_base.json` | 1,090,747 | `49a4e05dea02c8fafbd50cc4725c4aab8f39386c0afedef118e0dfebc2fe523a` |
| `tiktoken/o200k_base.json` | 2,325,457 | `df53e1a5f146e33a1b144d12ad9d685ee1b54dbc8b0950791ed45c933b119dc1` |
| `tiktoken/model_to_encoding.json` | 4,186 | `87a2d4e048ed2ebda0fee92a841b3527849574791bff16083c342a8b8f60688a` |
| `tiktoken/registry.json` | 2,697 | `14f210869183775a5de95f11c790dcfac07fcd5ed18eca37ac09a4b581ee379c` |

## 3. External tokenizers pinned by commit

Pinned upstream 1.19.0 does **not** pin these. `src/endpoints/tokenizers.js:260-264` fetches them at
runtime from `https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/<name>.json.gz`, a mutable
branch. That branch has already moved past what 1.19.0 references: its current HEAD adds `glm-4.6`
tokenizers, and the repository also contains `command-a-vision` files that 1.19.0 never uses. Exact
parity with "pinned upstream" is therefore not defined for these five families; GoTavern pins this
snapshot instead and records the deviation in `docs/tokenizer-parity-plan.md` §4 and §7.

Source: `SillyTavern/SillyTavern-Tokenizers` @ `798bcd823dfd04227a79b487e1cf29e6de9aaece`
(`main`, 2025-10-19, "Add glm-4.6 tokenizers"). Licence: MIT, Copyright (c) 2024 SillyTavern.

| file | `.gz` bytes | `.gz` SHA-256 | uncompressed bytes | uncompressed SHA-256 |
|---|---|---|---|---|
| `external/command-r.json.gz` | 3,688,933 | `132fc87df0e48b604b0888c2519f920f63757b9a85d74be698f3a1851d840007` | 8,960,966 | `23cf885a64b0f790f8da6ee36a47eef6005c9231287ee1ad22463a34d7b092d2` |
| `external/command-a.json.gz` | 3,689,028 | `cb15a5c52a21d51f342cc47360285715364a1cf60eedc078e1f97dd9f0c16e0c` | 8,961,533 | `c6a9a15bf2175a05fcbe58f1242678bba7d2afcef1138a54983bcbd1745e5d12` |
| `external/qwen2.json.gz` | 1,817,745 | `f874d7a2d4ba9591a980e7603648a43afeb3fa97740a3cd83cc74994f8affe52` | 4,754,645 | `fb366a22efb7db2dcca2c619402431cda342a97721395a2da2879ceb36262782` |
| `external/nemo.json.gz` | 2,345,925 | `97bb0b00f9c33bd9919283325eca46213c0aa991e984ea6799203d2872a63086` | 6,262,925 | `d27c2739d2d9ad785baa78f62ed23e79984246cb3e29c25d6cb5f43d9d00a6a9` |
| `external/deepseek.json.gz` | 1,759,988 | `8f148301305fec28917516aa009dacfb6ef3c791e621f8cdbc6b449683863aa5` | 4,299,301 | `a8d67ac5efa0def0716d813ccd9b288eaae51654221eb30112fb603cf241b247` |

The uncompressed digests were computed locally by decompressing the vendored `.gz` files. For
`deepseek.json` the decompressed digest was additionally confirmed against the repository's
uncompressed file at the same commit, which proves the `.gz` and `.json` blobs agree for that file.

## 4. What the runtime must do with these files (not yet implemented)

- Load lazily, per encoding, with a process-lifetime cache mirroring the pinned `tokenizersCache`.
- Resolve the five external files the way upstream resolves its `_cache`: an existing uncompressed
  `<name>.json` under `<DATA_ROOT>/_cache` wins; otherwise the pinned bytes are used and materialized
  as the uncompressed file, matching upstream's decompress-write-unlink side effect.
- When `enableDownloadableTokenizers` is false and `<DATA_ROOT>/_cache` has no entry, pinned upstream
  falls back to `llama3.json` for these five families. The Go implementation must reproduce that
  fallback and must **not** silently prefer the vendored bytes in that configuration.
- No network request is made by GoTavern where pinned Node would make one. Only the resulting cache
  bytes and token counts can match; that is a recorded deviation, not an unstated one.
