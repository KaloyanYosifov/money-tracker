package schema

import "embed"

// files holds the JSON Schemas. schema/scripts/generate.mjs copies them from schema/.
//
//go:embed json/*.schema.json
var files embed.FS
