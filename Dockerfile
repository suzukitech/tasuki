# syntax=docker/dockerfile:1
# Build runs on the builder's own arch and cross-compiles the binary for TARGETARCH
# (no QEMU for the slow part). Runtime is the single executable on a glibc slim base.
# Base images are pinned by multi-arch index digest (oven/bun:1.4.5, debian:bookworm-slim as of 2026-11-28).
# Bump tag and digest together: curl the registry for the index digest (Docker-Content-Digest header).
FROM --platform=$BUILDPLATFORM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS build
ARG TARGETARCH
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN case "$TARGETARCH" in \
      amd64) A=x64 ;; \
      arm64) A=arm64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && bun scripts/build-bin.ts "linux-$A" \
 && cp "dist/bin/tasuki-linux-$A" /tasuki

FROM debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e
RUN useradd --system --uid 10001 --home-dir /data --no-create-home tasuki \
 && mkdir /data && chown tasuki:tasuki /data
COPY --from=build /tasuki /usr/local/bin/tasuki
ENV TASUKI_DATA=/data PORT=3000
USER tasuki
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["tasuki", "healthcheck"]
ENTRYPOINT ["tasuki"]
CMD ["serve"]
