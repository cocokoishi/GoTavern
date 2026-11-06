#!/usr/bin/env node
// Print the SHARED corpus-schema field inventories as JSON (alpha.16 M1 drift gate).
//
// The Go half is `internal/longlivedfixture` (reflection over the schema structs:
// CorpusSchemaFieldNames, CorpusScenarioFieldNames, CorpusScenarioRecipeFieldNames, …); this tool prints the JS
// half from the SAME tables `validateScenario`/`validateSchema` walk, so a member is listed only if this side
// actually validates it. `tests/e2e/longlived_schema_test.go`
// (TestCorpusSchemaGoAndJSFieldInventoriesAgree) compares the two inventories BOTH ways and fails by name
// (`go-field-not-in-js:…`, `js-field-not-in-go:…`) when either side gains a field the other does not declare.
//
// The issue-name inventory is the second half of the vocabulary: a refusal name added on one side only would
// let the two readers disagree about what "malformed" means, so the same test compares those prefixes too.
//
// Usage:
//   node tools/longlived/schema-fields.mjs [--quiet]
//
// Prints one JSON object on stdout and exits 0. No filesystem access, no clock, no environment dependence.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
    SCHEMA_FIELDS,
    SCENARIO_ACTION_FIELDS,
    SCENARIO_BYTE_CENSUS_FIELDS,
    SCENARIO_EXTENSION_FIELDS,
    SCENARIO_FIELDS,
    SCENARIO_ISSUE_NAMES,
    SCENARIO_RECIPE_FIELDS,
    SCENARIO_RESOURCE_BOUND_FIELDS,
    SCENARIO_TREE_CHECKS,
} from './corpus-schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const payload = {
    schema: 'gotavern-corpus-schema-fields',
    schemaVersion: 1,
    tool: 'tools/longlived/schema-fields.mjs',
    repoRoot: path.resolve(here, '..', '..'),
    fields: {
        schema: [...SCHEMA_FIELDS].sort(),
        scenario: [...SCENARIO_FIELDS].sort(),
        recipe: [...SCENARIO_RECIPE_FIELDS].sort(),
        extension: [...SCENARIO_EXTENSION_FIELDS].sort(),
        action: [...SCENARIO_ACTION_FIELDS].sort(),
        byteCensus: [...SCENARIO_BYTE_CENSUS_FIELDS].sort(),
        resourceBounds: [...SCENARIO_RESOURCE_BOUND_FIELDS].sort(),
    },
    issueNames: [...SCENARIO_ISSUE_NAMES].sort(),
    treeChecks: [...SCENARIO_TREE_CHECKS].sort(),
};

console.log(JSON.stringify(payload));
