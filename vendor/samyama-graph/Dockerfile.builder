# Rust supplies Cargo and the compiler version used by this reconstructed tree.
FROM rust:1.88-bookworm

# RocksDB and zstd generate native bindings during compilation. clang and
# libclang provide those bindings; cmake builds the native compression code.
RUN apt-get update \
    && apt-get install -y --no-install-recommends clang libclang-dev cmake \
    && rm -rf /var/lib/apt/lists/*

# Using Cargo by absolute path avoids login-shell PATH differences.
ENTRYPOINT ["/usr/local/cargo/bin/cargo"]
