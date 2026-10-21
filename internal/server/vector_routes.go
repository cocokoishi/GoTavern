package server

// Handlers for the pinned /api/vector routes. See vector.go for the scope, the vectra format and
// the source coverage (webllm/koboldcpp produce vectors; provider embedding calls are a stated
// gap; the index path, scoring, purge and corruption repair are fully implemented).

import (
	"errors"
	"math"
	"net/http"
	"os"
	"path/filepath"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// serveVectorList is vectors.js:530.
func (runtime *accountRuntime) serveVectorList(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	if !pinnedJSTruthy(sdBodyMember(body, "collectionId")) {
		vectorStatus(w, http.StatusBadRequest)
		return
	}
	collectionID := vectorRequestCollectionID(body)
	source := vectorSourceName(body)
	settings := vectorSettingsFor(body, source)
	session, err := runtime.vectorOpenIndex(account, directories, source, collectionID, settings)
	if err != nil {
		runtime.vectorHandleError(w, request, account, directories, body, err)
		return
	}
	items, err := session.vectorItems()
	if err != nil {
		runtime.vectorHandleError(w, request, account, directories, body, err)
		return
	}
	hashes := nodeArray()
	for _, item := range items.array {
		metadata, metadataOK := sdMemberOf(item, "metadata")
		if !metadataOK {
			runtime.vectorHandleError(w, request, account, directories, body, errors.New("item metadata is null"))
			return
		}
		hash, hashOK := sdMemberOf(metadata, "hash")
		if !hashOK {
			runtime.vectorHandleError(w, request, account, directories, body, errors.New("item hash is null"))
			return
		}
		hashes.array = append(hashes.array, nodeNumber(vectorNumber(hash)))
	}
	vectorRespond(w, hashes)
}

// serveVectorInsert is vectors.js:512.
func (runtime *accountRuntime) serveVectorInsert(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	itemsNode := sdBodyMember(body, "items")
	if itemsNode.kind != 'a' || !pinnedJSTruthy(sdBodyMember(body, "collectionId")) {
		vectorStatus(w, http.StatusBadRequest)
		return
	}
	collectionID := vectorRequestCollectionID(body)
	source := vectorSourceName(body)
	settings := vectorSettingsFor(body, source)
	session, err := runtime.vectorOpenIndex(account, directories, source, collectionID, settings)
	if err != nil {
		runtime.vectorHandleError(w, request, account, directories, body, err)
		return
	}
	mapped := make([]orderedNodeJSON, 0, len(itemsNode.array))
	texts := make([]orderedNodeJSON, 0, len(itemsNode.array))
	for _, raw := range itemsNode.array {
		if raw.kind == 'n' || raw.kind == nodeUndefinedKind {
			// `x.hash` on null/undefined throws before the item can be skipped.
			runtime.vectorHandleError(w, request, account, directories, body, errors.New("item is null"))
			return
		}
		metadata := nodeObject()
		for _, key := range []string{"hash", "text", "index"} {
			member, memberOK := sdMemberOf(raw, key)
			if !memberOK {
				runtime.vectorHandleError(w, request, account, directories, body, errors.New("item member access failed"))
				return
			}
			if !member.isUndefined() {
				metadata.setMember(key, member)
			}
		}
		mapped = append(mapped, metadata)
		text, _ := metadata.member("text")
		texts = append(texts, text)
	}
	vectors, err := vectorGetVectors(source, settings, texts)
	if err != nil {
		runtime.vectorHandleError(w, request, account, directories, body, err)
		return
	}
	items, err := session.vectorItems()
	if err != nil {
		runtime.vectorHandleError(w, request, account, directories, body, err)
		return
	}
	for index, metadata := range mapped {
		vector := nodeUndefined()
		if index < len(vectors) {
			vector = vectors[index]
		}
		// `if (!item.vector) throw new Error('Vector is required')` — an empty array is truthy.
		if !pinnedJSTruthy(vector) {
			runtime.vectorHandleError(w, request, account, directories, body, errors.New("vector is required"))
			return
		}
		id, uuidErr := vectorUUID()
		if uuidErr != nil {
			runtime.vectorHandleError(w, request, account, directories, body, uuidErr)
			return
		}
		entry := nodeObject()
		entry.setMember("id", nodeString(id))
		entry.setMember("metadata", metadata)
		entry.setMember("vector", vector)
		entry.setMember("norm", nodeNumber(vectorNormalize(vector)))
		items.array = append(items.array, entry)
	}
	session.vectorSetItems(items)
	if err := runtime.vectorSave(session); err != nil {
		runtime.vectorHandleError(w, request, account, directories, body, err)
		return
	}
	vectorStatus(w, http.StatusOK)
}

// serveVectorDelete is vectors.js:547.
func (runtime *accountRuntime) serveVectorDelete(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	hashesNode := sdBodyMember(body, "hashes")
	if hashesNode.kind != 'a' || !pinnedJSTruthy(sdBodyMember(body, "collectionId")) {
		vectorStatus(w, http.StatusBadRequest)
		return
	}
	collectionID := vectorRequestCollectionID(body)
	source := vectorSourceName(body)
	settings := vectorSettingsFor(body, source)
	session, err := runtime.vectorOpenIndex(account, directories, source, collectionID, settings)
	if err != nil {
		runtime.vectorHandleError(w, request, account, directories, body, err)
		return
	}
	wanted := make([]float64, 0, len(hashesNode.array))
	for _, value := range hashesNode.array {
		wanted = append(wanted, vectorNumber(value))
	}
	items, err := session.vectorItems()
	if err != nil {
		runtime.vectorHandleError(w, request, account, directories, body, err)
		return
	}
	kept := nodeArray()
	for _, item := range items.array {
		metadata, metadataOK := sdMemberOf(item, "metadata")
		if !metadataOK {
			runtime.vectorHandleError(w, request, account, directories, body, errors.New("item metadata is null"))
			return
		}
		hash, hashOK := sdMemberOf(metadata, "hash")
		if !hashOK {
			runtime.vectorHandleError(w, request, account, directories, body, errors.New("item hash is null"))
			return
		}
		// ItemSelector.metadataFilter's $in: a boolean value is never a match, otherwise
		// Array.includes uses strict equality against the numeric hash list.
		matched := false
		if hash.kind == 'v' {
			number, isNumber := hash.scalar.(float64)
			if isNumber && !math.IsNaN(number) {
				for _, candidate := range wanted {
					if candidate == number {
						matched = true
						break
					}
				}
			}
		}
		if !matched {
			kept.array = append(kept.array, item)
		}
	}
	session.vectorSetItems(kept)
	if err := runtime.vectorSave(session); err != nil {
		runtime.vectorHandleError(w, request, account, directories, body, err)
		return
	}
	vectorStatus(w, http.StatusOK)
}

// serveVectorQuery is vectors.js:472.
func (runtime *accountRuntime) serveVectorQuery(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	if !pinnedJSTruthy(sdBodyMember(body, "collectionId")) || !pinnedJSTruthy(sdBodyMember(body, "searchText")) {
		vectorStatus(w, http.StatusBadRequest)
		return
	}
	collectionID := vectorRequestCollectionID(body)
	source := vectorSourceName(body)
	settings := vectorSettingsFor(body, source)
	topK := vectorTopK(body)
	threshold := vectorThreshold(body)
	session, err := runtime.vectorOpenIndex(account, directories, source, collectionID, settings)
	if err != nil {
		runtime.vectorHandleError(w, request, account, directories, body, err)
		return
	}
	queryVector, err := vectorGetQueryVector(source, settings, nodeString(vectorRequestSearchText(body)))
	if err != nil {
		runtime.vectorHandleError(w, request, account, directories, body, err)
		return
	}
	topItems, err := session.vectorTopItems(queryVector, topK)
	if err != nil {
		runtime.vectorHandleError(w, request, account, directories, body, err)
		return
	}
	metadata := nodeArray()
	hashes := nodeArray()
	for _, item := range topItems {
		hashes.array = append(hashes.array, vectorMetadataHash(item.metadata))
		if item.score >= threshold {
			metadata.array = append(metadata.array, item.metadata)
		}
	}
	result := nodeObject()
	result.setMember("metadata", metadata)
	result.setMember("hashes", hashes)
	vectorRespond(w, result)
}

// serveVectorQueryMulti is vectors.js:492.
func (runtime *accountRuntime) serveVectorQueryMulti(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	collectionIDsNode := sdBodyMember(body, "collectionIds")
	if collectionIDsNode.kind != 'a' || !pinnedJSTruthy(sdBodyMember(body, "searchText")) {
		vectorStatus(w, http.StatusBadRequest)
		return
	}
	source := vectorSourceName(body)
	settings := vectorSettingsFor(body, source)
	topK := vectorTopK(body)
	threshold := vectorThreshold(body)
	queryVector, err := vectorGetQueryVector(source, settings, nodeString(vectorRequestSearchText(body)))
	if err != nil {
		runtime.vectorHandleError(w, request, account, directories, body, err)
		return
	}
	type multiEntry struct {
		collectionID string
		item         vectorQueryItem
	}
	entries := make([]multiEntry, 0)
	for _, rawID := range collectionIDsNode.array {
		collectionID := vectorStringMember(rawID)
		session, openErr := runtime.vectorOpenIndex(account, directories, source, collectionID, settings)
		if openErr != nil {
			runtime.vectorHandleError(w, request, account, directories, body, openErr)
			return
		}
		topItems, queryErr := session.vectorTopItems(queryVector, topK)
		if queryErr != nil {
			runtime.vectorHandleError(w, request, account, directories, body, queryErr)
			return
		}
		for _, item := range topItems {
			entries = append(entries, multiEntry{collectionID: collectionID, item: item})
		}
	}
	scores := make([]float64, len(entries))
	indexes := make([]int, len(entries))
	for index := range entries {
		scores[index] = entries[index].item.score
		indexes[index] = index
	}
	vectorStableDescendingSort(scores, indexes)
	filtered := make([]int, 0, len(indexes))
	for _, index := range indexes {
		if entries[index].item.score >= threshold {
			filtered = append(filtered, index)
		}
	}
	selected := vectorSliceTopKIndexes(filtered, topK)
	grouped := nodeObject()
	for _, index := range selected {
		entry := entries[index]
		group, exists := grouped.member(entry.collectionID)
		if !exists {
			group = nodeObject()
			group.setMember("hashes", nodeArray())
			group.setMember("metadata", nodeArray())
			grouped.setMember(entry.collectionID, group)
		}
		hashes, _ := group.member("hashes")
		metadata, _ := group.member("metadata")
		hashes.array = append(hashes.array, vectorMetadataHash(entry.item.metadata))
		metadata.array = append(metadata.array, entry.item.metadata)
		group.setMember("hashes", hashes)
		group.setMember("metadata", metadata)
	}
	vectorRespond(w, grouped)
}

// serveVectorPurgeAll is vectors.js:565.
func (runtime *accountRuntime) serveVectorPurgeAll(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	if _, ok := runtime.sdRequestBody(w, request); !ok {
		return
	}
	for _, source := range vectorSources {
		target := filepath.Join(directories["vectors"], startup.SanitizeUserFilename(source))
		if _, err := os.Stat(target); err != nil {
			continue
		}
		if err := runtime.vectorRemoveDirectory(account, directories, target); err != nil {
			vectorStatus(w, http.StatusInternalServerError)
			return
		}
	}
	vectorStatus(w, http.StatusOK)
}

// serveVectorPurge is vectors.js:583.
func (runtime *accountRuntime) serveVectorPurge(w http.ResponseWriter, request *http.Request) {
	account, directories, ok := runtime.sdUser(w, request)
	if !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	if !pinnedJSTruthy(sdBodyMember(body, "collectionId")) {
		vectorStatus(w, http.StatusBadRequest)
		return
	}
	collectionID := vectorRequestCollectionID(body)
	for _, source := range vectorSources {
		target := filepath.Join(directories["vectors"], startup.SanitizeUserFilename(source), startup.SanitizeUserFilename(collectionID))
		if _, err := os.Stat(target); err != nil {
			continue
		}
		if err := runtime.vectorRemoveDirectory(account, directories, target); err != nil {
			vectorStatus(w, http.StatusInternalServerError)
			return
		}
	}
	vectorStatus(w, http.StatusOK)
}
