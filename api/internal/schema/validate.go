package schema

import (
	"bytes"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// ErrUnknownTable is returned for a table that has no schema.
var ErrUnknownTable = errors.New("unknown table")

// tableSchemas maps each synced table to its schema file.
var tableSchemas = map[string]string{
	"accounts":        "account.schema.json",
	"categories":      "category.schema.json",
	"transactions":    "transaction.schema.json",
	"recurring_rules": "recurring_rule.schema.json",
	"budgets":         "budget.schema.json",
	"user_settings":   "user_settings.schema.json",
}

const uploadSchema = "upload.schema.json"

// Validator checks upload bodies and records against the embedded schemas.
// The values to check must come from jsonschema.UnmarshalJSON (or a decoder
// with UseNumber), so that 1.0 and 1 stay different numbers.
type Validator struct {
	upload *jsonschema.Schema
	full   map[string]*jsonschema.Schema
	patch  map[string]*jsonschema.Schema
}

// NewValidator compiles all embedded schemas. Call it once at start.
func NewValidator() (*Validator, error) {
	docs := map[string]any{}
	for _, name := range append(slices.Collect(maps.Values(tableSchemas)), uploadSchema) {
		raw, err := files.ReadFile("json/" + name)
		if err != nil {
			return nil, fmt.Errorf("read schema %s: %w", name, err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("parse schema %s: %w", name, err)
		}
		docs[name] = doc
	}

	full, err := compile(docs, false)
	if err != nil {
		return nil, err
	}
	patch, err := compile(docs, true)
	if err != nil {
		return nil, err
	}
	v := &Validator{upload: full[uploadSchema], full: map[string]*jsonschema.Schema{}, patch: map[string]*jsonschema.Schema{}}
	for table, name := range tableSchemas {
		v.full[table] = full[name]
		v.patch[table] = patch[name]
	}
	return v, nil
}

// compile compiles each document. If dropRequired is true, it compiles a copy
// without the top-level "required" keyword.
func compile(docs map[string]any, dropRequired bool) (map[string]*jsonschema.Schema, error) {
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	for name, doc := range docs {
		if dropRequired {
			obj, ok := doc.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("schema %s is not an object", name)
			}
			obj = maps.Clone(obj)
			delete(obj, "required")
			doc = obj
		}
		if err := c.AddResource(name, doc); err != nil {
			return nil, fmt.Errorf("add schema %s: %w", name, err)
		}
	}
	out := map[string]*jsonschema.Schema{}
	for name := range docs {
		sch, err := c.Compile(name)
		if err != nil {
			return nil, fmt.Errorf("compile schema %s: %w", name, err)
		}
		out[name] = sch
	}
	return out, nil
}

// ValidateUpload checks a whole upload body against upload.schema.json.
func (v *Validator) ValidateUpload(body any) error {
	return check(v.upload, body)
}

// ValidatePut checks the full record of a PUT op.
func (v *Validator) ValidatePut(table string, data any) error {
	sch, ok := v.full[table]
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownTable, table)
	}
	return check(sch, data)
}

// ValidatePatch checks the partial record of a PATCH op. No field is required.
func (v *Validator) ValidatePatch(table string, data any) error {
	sch, ok := v.patch[table]
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownTable, table)
	}
	return check(sch, data)
}

var printer = message.NewPrinter(language.English)

// check returns an error with one line for each failed field, for example
// "at '/amount_minor': got number, want integer".
func check(sch *jsonschema.Schema, data any) error {
	err := sch.Validate(data)
	var verr *jsonschema.ValidationError
	if !errors.As(err, &verr) {
		return err
	}
	var lines []string
	collect(verr, &lines)
	return errors.New(strings.Join(lines, "; "))
}

func collect(e *jsonschema.ValidationError, lines *[]string) {
	if len(e.Causes) == 0 {
		loc := "/" + strings.Join(e.InstanceLocation, "/")
		*lines = append(*lines, fmt.Sprintf("at '%s': %s", loc, e.ErrorKind.LocalizedString(printer)))
		return
	}
	for _, c := range e.Causes {
		collect(c, lines)
	}
}
