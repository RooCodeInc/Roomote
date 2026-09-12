FROM golang:1.26.1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends nodejs curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /gateway
COPY iron.lock build.sh verify-archive.mjs patch-iron.mjs ./
COPY overlay ./overlay
RUN bash build.sh prepare && \
    . ./iron.lock && \
    CGO_ENABLED=0 go -C ".build/iron-proxy-$IRON_GIT_SHA" build -trimpath -o /gateway/session-egress-gateway ./cmd/iron-proxy

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /gateway/session-egress-gateway /session-egress-gateway
COPY --from=build /gateway/.build/iron-proxy-2393dd175a8c419153fb49917fdeceb94cd9ed59/LICENSE /usr/share/licenses/iron-proxy/LICENSE
COPY iron.lock /usr/share/licenses/iron-proxy/iron.lock
ENTRYPOINT ["/session-egress-gateway"]
