# syntax=docker/dockerfile:1

# Build stage. The Go toolchain is a BUILD-TIME dependency only: the runtime
# image contains no Go, no Node and no npm, per the distribution rules in
# ARCHITECTURE.md section 5.
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO_ENABLED=0 keeps the binary statically linked, so a minimal production
# machine needs no extra runtime.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/gotavern ./cmd/gotavern

# Runtime stage: minimal, non-root.
FROM alpine:3.20
# CA certificates are needed for outbound provider TLS, and busybox wget backs
# the healthcheck. Nothing else is installed; there is no compiler and no Node.
RUN apk add --no-cache ca-certificates \
    && addgroup -S gotavern \
    && adduser -S -G gotavern -h /data gotavern

# The install root is the directory holding the binary: the runtime resolves
# <InstallRoot>/src/tokenizers from there, and `gotavern assets verify` hashes the
# same tree.
WORKDIR /app
COPY --from=build /out/gotavern /app/gotavern
# tokenizers is a DISK TREE, not embedded. upstream/assets.go embeds public,
# default, generated and manifests only, and only the tokenizer MANIFEST is
# embedded; the routes read the tree from disk. Without it the tokenizer routes
# take the pinned FALLBACK path and count prompts wrong while still answering,
# which is why `gotavern assets verify` fails when it is absent and why this COPY
# is load-bearing rather than an optimisation.
#
# IT GOES UNDER src/ BECAUSE THAT IS THE PINNED LAYOUT: upstream reads these files
# server-side by a relative path (`new SentencePieceTokenizer('src/tokenizers/
# llama.model')`, src/endpoints/tokenizers.js:251-254). The runtime accepts
# <root>/src/tokenizers first, then the legacy <root>/tokenizers, then
# <root>/upstream/tokenizers -- so this image and a release archive agree.
COPY upstream/tokenizers /app/src/tokenizers
COPY LICENSE THIRD_PARTY_NOTICES.txt /app/

# Pinned startup creates the PUBLIC_DIRECTORIES tree UNDER THE INSTALL ROOT:
# public/img, public/sounds, public/scripts/extensions,
# public/scripts/extensions/third-party and backups. In a release layout the
# install root is the binary's directory, so those paths must exist and be
# writable by the runtime user or the container cannot start as non-root. They
# are pre-created and owned by the runtime user; the binary itself stays
# root-owned so the process cannot replace it.
RUN mkdir -p /app/public/img /app/public/sounds \
        /app/public/scripts/extensions/third-party /app/backups \
    && chown -R gotavern:gotavern /app/public /app/backups

# The working directory is where config.yaml is resolved from, and the data root
# is set explicitly below. No config.yaml and no data/ are baked in, so
# extraction can never overwrite a live installation.
WORKDIR /data
RUN chown -R gotavern:gotavern /data
VOLUME ["/data"]

USER gotavern
EXPOSE 8000

# --listen true binds the container interface. The pinned default config keeps
# whitelistMode on, which is what satisfies the startup security gate for a
# non-localhost listener; the default whitelist already allows 127.0.0.1, so the
# healthcheck below is permitted.
#
# --dataRoot is REQUIRED here, and it is a supported flag rather than a
# workaround. Pinned src/command-line.js:288-290 is
#     const dataRoot = isGlobal ? defaultConfig.dataRoot
#                               : (cliArguments.dataRoot ?? getConfigValue('dataRoot', defaultConfig.dataRoot));
# so the argument is honoured outside global mode; the only "ignored" warning is
# the global-mode one. Without it, the config's relative `dataRoot: ./data` is
# resolved against the SERVER directory, which is the binary's own directory
# because install root = filepath.Dir(os.Executable()). The data root then
# becomes /app/data, outside the volume, and startup fails writing
# cookie-secret.txt there as a non-root user. The documented launch path never
# hits this because start.sh cds to the install root first; a container does not.
ENTRYPOINT ["/app/gotavern"]
CMD ["start", "--listen", "true", "--port", "8000", "--dataRoot", "/data/data"]

# /version is a pinned public compatibility route: no session and no CSRF, so it
# is a valid liveness probe rather than an invented endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
    CMD wget -q -O - http://127.0.0.1:8000/version > /dev/null || exit 1
