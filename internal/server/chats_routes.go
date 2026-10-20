package server

// Route registration for the chats and groups domains owned by this file set.
// /api/chats/save and /api/chats/get are registered in chats.go.

import "net/http"

func init() {
	domainRouteRegistrars = append(domainRouteRegistrars, registerChatAndGroupRoutes)
}

func registerChatAndGroupRoutes(mux *http.ServeMux, accounts *accountRuntime, notFoundPage []byte, options HTTPHandlerOptions) {
	// The pinned routes are POST-only and Express answers any other method with
	// the final 404 rather than a 405, so dispatch manually.
	post := func(pattern string, handler func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				serveStatic(w, r, notFoundPage, options)
				return
			}
			handler(w, r)
		})
	}
	post("/api/chats/rename", accounts.serveChatsRename)
	post("/api/chats/delete", accounts.serveChatsDelete)
	post("/api/chats/export", accounts.serveChatsExport)
	post("/api/chats/import", accounts.serveChatsImport)
	post("/api/chats/search", accounts.serveChatsSearch)
	post("/api/chats/recent", accounts.serveChatsRecent)
	post("/api/chats/group/get", accounts.serveChatsGroupGet)
	post("/api/chats/group/info", accounts.serveChatsGroupInfo)
	post("/api/chats/group/save", accounts.serveChatsGroupSave)
	post("/api/chats/group/delete", accounts.serveChatsGroupDelete)
	post("/api/chats/group/import", accounts.serveChatsGroupImport)
	post("/api/groups/all", accounts.serveGroupsAll)
	post("/api/groups/create", accounts.serveGroupsCreate)
	post("/api/groups/edit", accounts.serveGroupsEdit)
	post("/api/groups/delete", accounts.serveGroupsDelete)
}
