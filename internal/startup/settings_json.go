package startup

import "errors"

// FormatSettingsJSON reproduces JSON.parse followed by
// JSON.stringify(value, null, 4) for JSON object and array request bodies.
func FormatSettingsJSON(body []byte) ([]byte, error) {
	value, err := decodeOrderedJSON(body)
	if err != nil {
		return nil, err
	}
	switch value.(type) {
	case *orderedJSONObject, orderedJSONArray:
		return marshalNodeJSONIndent(value)
	default:
		return nil, errors.New("settings JSON must be an object or array")
	}
}
