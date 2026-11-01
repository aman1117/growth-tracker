# syntax=docker/dockerfile:1
# Production image for the Growth Tracker API server (Rust).

# Build stage: a static musl binary (TLS via rustls, no OpenSSL needed)
ARG RUST_VERSION=1
FROM rust:${RUST_VERSION}-alpine AS builder

RUN apk add --no-cache musl-dev

WORKDIR /app

# Copy the workspace (docs/ holds the OpenAPI document embedded into the binary)
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY docs ./docs

# Cache the registry and build directory between builds
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release --locked --bin server && \
    cp target/release/server /usr/local/bin/server

# Runtime stage
FROM alpine:3.20

WORKDIR /app

# ca-certificates for HTTPS (Postgres TLS, Resend, Azure); tzdata for completeness
RUN apk --no-cache add ca-certificates tzdata

COPY --from=builder /usr/local/bin/server ./server

EXPOSE 8000

CMD ["./server"]
