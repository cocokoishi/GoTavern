package server

// The nine pinned multimodal-model list routes, from src/endpoints/backends/chat-completions.js
// lines 2733-2975. All of them return a JSON array of model names; a non-2xx peer and the
// "invalid data" branch return an empty array with status 200, while a thrown fetch or a
// structural access that throws answers a plain 500.

import (
	"net/http"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type backendsMultimodalSpec struct {
	// secretKey is read before the request; an absent value answers res.json([]) like pinned.
	secretKey string
	// accountID makes the route read request.body.workers_ai_account_id and require it.
	accountID bool
	// bearer adds Authorization: Bearer <secret>.
	bearer bool
	// target builds the upstream URL from the seam and, for Workers AI, the account id.
	target func(accountID string) string
	// list maps the parsed upstream JSON to the returned names. A false ok means the pinned
	// structural access would throw, which is the route's 500 branch.
	list func(data orderedNodeJSON) (orderedNodeJSON, bool)
}

func (runtime *accountRuntime) serveBackendsMultimodal(w http.ResponseWriter, request *http.Request, spec backendsMultimodalSpec) {
	_, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	headers := map[string]string(nil)
	if spec.secretKey != "" {
		key, err := sdReadSecret(directories, spec.secretKey)
		if err != nil {
			backendsStatus(w, http.StatusInternalServerError)
			return
		}
		if key == "" {
			backendsEmptyList(w)
			return
		}
		if spec.bearer {
			headers = map[string]string{"authorization": "Bearer " + key}
		}
	}
	accountID := ""
	if spec.accountID {
		accountID = backendsWorkersAIAccountID(body)
		if accountID == "" {
			backendsEmptyList(w)
			return
		}
	}
	response, responseOK, err := backendsGet(request, spec.target(accountID), headers)
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	if !responseOK {
		backendsEmptyList(w)
		return
	}
	data, parsed := sdReadJSON(response)
	if !parsed {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	list, listOK := spec.list(data)
	if !listOK {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	backendsJSON(w, list)
}

// backendsArrayMemberValue is `value.member`, requiring an object; null/undefined report false
// because the pinned expression would throw.
func backendsArrayMemberValue(value orderedNodeJSON, member string) (orderedNodeJSON, bool) {
	return sdMemberOf(value, member)
}

// backendsOptionalMember is `value?.member`: null/undefined yield undefined without throwing.
func backendsOptionalMember(value orderedNodeJSON, member string) orderedNodeJSON {
	if value.kind == 'n' || value.kind == nodeUndefinedKind {
		return nodeUndefined()
	}
	item, ok := sdMemberOf(value, member)
	if !ok {
		return nodeUndefined()
	}
	return item
}

// backendsArrayContainsString is `array.includes(text)` with strict equality.
func backendsArrayContainsString(array orderedNodeJSON, text string) bool {
	if array.kind != 'a' {
		return false
	}
	for _, item := range array.array {
		if value, ok := item.stringValue(); ok && value == text {
			return true
		}
	}
	return false
}

// backendsMapNames applies the pinned filter chain: skip values whose guard is false, require the
// fields each route accesses, and append the name/id member (which may be undefined -> null).
func backendsMapMultimodal(data orderedNodeJSON, items orderedNodeJSON, guard func(item orderedNodeJSON) (bool, bool), name func(item orderedNodeJSON) (orderedNodeJSON, bool)) (orderedNodeJSON, bool) {
	if items.kind != 'a' {
		return orderedNodeJSON{}, false
	}
	names := nodeArray()
	for _, item := range items.array {
		keep, keepOK := guard(item)
		if !keepOK {
			return orderedNodeJSON{}, false
		}
		if !keep {
			continue
		}
		value, valueOK := name(item)
		if !valueOK {
			return orderedNodeJSON{}, false
		}
		names.array = append(names.array, value)
	}
	return names, true
}

// serveBackendsMultimodalPollinations is chat-completions.js:2733.
func (runtime *accountRuntime) serveBackendsMultimodalPollinations(w http.ResponseWriter, request *http.Request) {
	runtime.serveBackendsMultimodal(w, request, backendsMultimodalSpec{
		target: func(string) string { return backendsPollinationsURL() + "/models" },
		list: func(data orderedNodeJSON) (orderedNodeJSON, bool) {
			if data.kind != 'a' {
				return nodeArray(), true
			}
			return backendsMapMultimodal(data, data,
				func(item orderedNodeJSON) (bool, bool) {
					modalities := backendsOptionalMember(item, "input_modalities")
					if modalities.kind != 'a' {
						return false, true
					}
					return backendsArrayContainsString(modalities, "image"), true
				},
				func(item orderedNodeJSON) (orderedNodeJSON, bool) {
					return sdMemberOf(item, "name")
				})
		},
	})
}

// serveBackendsMultimodalAimlapi is chat-completions.js:2759.
func (runtime *accountRuntime) serveBackendsMultimodalAimlapi(w http.ResponseWriter, request *http.Request) {
	runtime.serveBackendsMultimodal(w, request, backendsMultimodalSpec{
		target: func(string) string { return backendsAimlapiURL() + "/v1/models" },
		list: func(data orderedNodeJSON) (orderedNodeJSON, bool) {
			entries := backendsOptionalMember(data, "data")
			if entries.kind != 'a' {
				return nodeArray(), true
			}
			return backendsMapMultimodal(data, entries,
				func(item orderedNodeJSON) (bool, bool) {
					features := backendsOptionalMember(item, "features")
					return backendsArrayContainsString(features, "openai/chat-completion.vision"), true
				},
				func(item orderedNodeJSON) (orderedNodeJSON, bool) {
					return sdMemberOf(item, "id")
				})
		},
	})
}

// serveBackendsMultimodalNanoGPT is chat-completions.js:2782.
func (runtime *accountRuntime) serveBackendsMultimodalNanoGPT(w http.ResponseWriter, request *http.Request) {
	runtime.serveBackendsMultimodal(w, request, backendsMultimodalSpec{
		target: func(string) string { return backendsNanoGPTURL() + "/api/v1/models?detailed=true" },
		list: func(data orderedNodeJSON) (orderedNodeJSON, bool) {
			entries := backendsOptionalMember(data, "data")
			if entries.kind != 'a' {
				return nodeArray(), true
			}
			return backendsMapMultimodal(data, entries,
				func(item orderedNodeJSON) (bool, bool) {
					capabilities := backendsOptionalMember(item, "capabilities")
					return pinnedJSTruthy(backendsOptionalMember(capabilities, "vision")), true
				},
				func(item orderedNodeJSON) (orderedNodeJSON, bool) {
					return sdMemberOf(item, "id")
				})
		},
	})
}

// serveBackendsMultimodalElectronHub is chat-completions.js:2805. This handler has no optional
// chain on data.data, so a missing data member throws and answers 500.
func (runtime *accountRuntime) serveBackendsMultimodalElectronHub(w http.ResponseWriter, request *http.Request) {
	runtime.serveBackendsMultimodal(w, request, backendsMultimodalSpec{
		target: func(string) string { return backendsElectronHubURL() + "/v1/models" },
		list: func(data orderedNodeJSON) (orderedNodeJSON, bool) {
			entries, ok := backendsArrayMemberValue(data, "data")
			if !ok || entries.kind != 'a' {
				return orderedNodeJSON{}, false
			}
			return backendsMapMultimodal(data, entries,
				func(item orderedNodeJSON) (bool, bool) {
					metadata, ok := backendsArrayMemberValue(item, "metadata")
					if !ok {
						return false, false
					}
					return pinnedJSTruthy(backendsOptionalMember(metadata, "vision")), true
				},
				func(item orderedNodeJSON) (orderedNodeJSON, bool) {
					return sdMemberOf(item, "id")
				})
		},
	})
}

// serveBackendsMultimodalChutes is chat-completions.js:2823.
func (runtime *accountRuntime) serveBackendsMultimodalChutes(w http.ResponseWriter, request *http.Request) {
	runtime.serveBackendsMultimodal(w, request, backendsMultimodalSpec{
		secretKey: "api_key_chutes",
		bearer:    true,
		target:    func(string) string { return backendsChutesURL() + "/v1/models" },
		list: func(data orderedNodeJSON) (orderedNodeJSON, bool) {
			entries, ok := backendsArrayMemberValue(data, "data")
			if !ok || entries.kind != 'a' {
				return orderedNodeJSON{}, false
			}
			return backendsMapMultimodal(data, entries,
				func(item orderedNodeJSON) (bool, bool) {
					modalities, ok := backendsArrayMemberValue(item, "input_modalities")
					if !ok {
						return false, false
					}
					return backendsArrayContainsString(modalities, "image"), true
				},
				func(item orderedNodeJSON) (orderedNodeJSON, bool) {
					return sdMemberOf(item, "id")
				})
		},
	})
}

// serveBackendsMultimodalMistral is chat-completions.js:2854.
func (runtime *accountRuntime) serveBackendsMultimodalMistral(w http.ResponseWriter, request *http.Request) {
	runtime.serveBackendsMultimodal(w, request, backendsMultimodalSpec{
		secretKey: "api_key_mistralai",
		bearer:    true,
		target:    func(string) string { return backendsMistralURL() + "/v1/models" },
		list: func(data orderedNodeJSON) (orderedNodeJSON, bool) {
			entries, ok := backendsArrayMemberValue(data, "data")
			if !ok || entries.kind != 'a' {
				return orderedNodeJSON{}, false
			}
			return backendsMapMultimodal(data, entries,
				func(item orderedNodeJSON) (bool, bool) {
					capabilities, ok := backendsArrayMemberValue(item, "capabilities")
					if !ok {
						return false, false
					}
					return pinnedJSTruthy(backendsOptionalMember(capabilities, "vision")), true
				},
				func(item orderedNodeJSON) (orderedNodeJSON, bool) {
					return sdMemberOf(item, "id")
				})
		},
	})
}

// serveBackendsMultimodalXai is chat-completions.js:2882: /language-models, plus the pinned
// append of grok-4-0709 when the endpoint omits it.
func (runtime *accountRuntime) serveBackendsMultimodalXai(w http.ResponseWriter, request *http.Request) {
	runtime.serveBackendsMultimodal(w, request, backendsMultimodalSpec{
		secretKey: "api_key_xai",
		bearer:    true,
		target:    func(string) string { return backendsXaiURL() + "/v1/language-models" },
		list: func(data orderedNodeJSON) (orderedNodeJSON, bool) {
			entries, ok := backendsArrayMemberValue(data, "models")
			if !ok || entries.kind != 'a' {
				return orderedNodeJSON{}, false
			}
			names, ok := backendsMapMultimodal(data, entries,
				func(item orderedNodeJSON) (bool, bool) {
					modalities, ok := backendsArrayMemberValue(item, "input_modalities")
					if !ok {
						return false, false
					}
					return backendsArrayContainsString(modalities, "image"), true
				},
				func(item orderedNodeJSON) (orderedNodeJSON, bool) {
					return sdMemberOf(item, "id")
				})
			if !ok {
				return orderedNodeJSON{}, false
			}
			found := false
			for _, item := range names.array {
				if text, isString := item.stringValue(); isString && text == "grok-4-0709" {
					found = true
					break
				}
			}
			if !found {
				names.array = append(names.array, nodeString("grok-4-0709"))
			}
			return names, true
		},
	})
}

// serveBackendsMultimodalMoonshot is chat-completions.js:2915.
func (runtime *accountRuntime) serveBackendsMultimodalMoonshot(w http.ResponseWriter, request *http.Request) {
	runtime.serveBackendsMultimodal(w, request, backendsMultimodalSpec{
		secretKey: "api_key_moonshot",
		bearer:    true,
		target:    func(string) string { return backendsMoonshotURL() + "/v1/models" },
		list: func(data orderedNodeJSON) (orderedNodeJSON, bool) {
			entries, ok := backendsArrayMemberValue(data, "data")
			if !ok || entries.kind != 'a' {
				return orderedNodeJSON{}, false
			}
			return backendsMapMultimodal(data, entries,
				func(item orderedNodeJSON) (bool, bool) {
					flag, ok := backendsArrayMemberValue(item, "supports_image_in")
					if !ok {
						return false, false
					}
					return pinnedJSTruthy(flag), true
				},
				func(item orderedNodeJSON) (orderedNodeJSON, bool) {
					return sdMemberOf(item, "id")
				})
		},
	})
}

// serveBackendsMultimodalWorkersAI is chat-completions.js:2944: the account id is part of the
// path and both the key and the account id are required for any request.
func (runtime *accountRuntime) serveBackendsMultimodalWorkersAI(w http.ResponseWriter, request *http.Request) {
	runtime.serveBackendsMultimodal(w, request, backendsMultimodalSpec{
		secretKey: "api_key_workers_ai",
		accountID: true,
		bearer:    true,
		target: func(accountID string) string {
			return backendsWorkersAIURL() + "/client/v4/accounts/" + sdEncodeURIComponent(accountID) + "/ai/models/search?task=Text+Generation&per_page=1000"
		},
		list: func(data orderedNodeJSON) (orderedNodeJSON, bool) {
			entries := backendsOptionalMember(data, "result")
			if entries.kind != 'a' {
				return nodeArray(), true
			}
			return backendsMapMultimodal(data, entries,
				func(item orderedNodeJSON) (bool, bool) {
					properties, ok := backendsArrayMemberValue(item, "properties")
					if !ok {
						return false, false
					}
					if properties.kind != 'a' {
						return false, true
					}
					for _, property := range properties.array {
						propertyID, ok := backendsArrayMemberValue(property, "property_id")
						if !ok {
							return false, false
						}
						value, ok := backendsArrayMemberValue(property, "value")
						if !ok {
							return false, false
						}
						idText, idString := propertyID.stringValue()
						valueText, valueString := value.stringValue()
						if idString && valueString && idText == "vision" && valueText == "true" {
							return true, true
						}
					}
					return false, true
				},
				func(item orderedNodeJSON) (orderedNodeJSON, bool) {
					return sdMemberOf(item, "name")
				})
		},
	})
}

var _ = startup.UserDirectories{}
