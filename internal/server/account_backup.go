package server

import (
	"archive/zip"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (runtime *accountRuntime) serveUserBackup(w http.ResponseWriter, request *http.Request) {
	input, ok := readAccountRequestBody(request)
	if !ok {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if runtime.fullDataBackupAllowed() == false {
		respondJSON(w, http.StatusForbidden, map[string]string{"error": "Full data backup is disabled"})
		return
	}
	if !nodeTruthyJSON(input["handle"]) {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing required fields"})
		return
	}
	account := runtime.requestAccount(accountFromContext(request))
	if account == nil {
		serveStatusText(w, http.StatusForbidden)
		return
	}
	var handle string
	if json.Unmarshal(input["handle"], &handle) != nil {
		if !nodeTruthyJSON(account.raw("admin")) {
			respondJSON(w, http.StatusForbidden, map[string]string{"error": "Unauthorized"})
		} else {
			serveStatusText(w, http.StatusInternalServerError)
		}
		return
	}
	if handle != account.string("handle") && !nodeTruthyJSON(account.raw("admin")) {
		respondJSON(w, http.StatusForbidden, map[string]string{"error": "Unauthorized"})
		return
	}
	if runtime.options.DataRoot == "" {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	root := filepath.Join(runtime.options.DataRoot, filepath.FromSlash(handle))
	temporary, err := os.CreateTemp("", "gotavern-full-backup-*.zip")
	if err != nil {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := writeUserBackupZip(temporary, root, runtime.options.AllowKeysExposure); err != nil {
		_ = temporary.Close()
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	if _, err := temporary.Seek(0, io.SeekStart); err != nil {
		_ = temporary.Close()
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	filename := handle + "-" + time.Now().Format("20060102-150405") + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", backupAttachmentHeader(filename))
	w.Header().Set("Vary", "Origin")
	if _, err := io.Copy(w, temporary); err != nil {
		_ = temporary.Close()
		return
	}
	_ = temporary.Close()
}

func backupAttachmentHeader(filename string) string {
	escaped := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(filename)
	return `attachment; filename="` + escaped + `"`
}

func (runtime *accountRuntime) fullDataBackupAllowed() bool {
	return runtime.options.AllowFullDataBackup == nil || *runtime.options.AllowFullDataBackup
}

func writeUserBackupZip(output io.Writer, root string, allowKeysExposure bool) error {
	archive := zip.NewWriter(output)
	walkErr := filepath.WalkDir(root, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if current == root {
			return nil
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if !allowKeysExposure && isPrivateBackupFile(relative) {
			return nil
		}
		if info.IsDir() {
			header := &zip.FileHeader{Name: relative + "/", Method: zip.Store}
			header.SetModTime(info.ModTime())
			header.SetMode(info.Mode())
			_, err = archive.CreateHeader(header)
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = relative
		header.Method = zip.Deflate
		header.SetModTime(info.ModTime())
		header.SetMode(info.Mode())
		writer, err := archive.CreateHeader(header)
		if err != nil {
			return err
		}
		file, err := os.Open(current)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(writer, file)
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
	closeErr := archive.Close()
	if walkErr != nil {
		return walkErr
	}
	return closeErr
}

func isPrivateBackupFile(relative string) bool {
	if relative == "secrets.json" {
		return true
	}
	return strings.HasPrefix(relative, "backups/secrets_migration_") && strings.HasSuffix(relative, ".json")
}
