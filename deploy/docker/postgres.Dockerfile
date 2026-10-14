# Postgres with pgvector (ADR 0011: ontology term embeddings for the mapping stage).
#
# Built on the same postgres:17-alpine image the stack has always run, so an existing data
# volume keeps its musl collations: moving to the Debian-based pgvector image would change them
# and call for a REINDEX of every text index. pgvector is compiled from a pinned release.
FROM postgres:17-alpine

ARG PGVECTOR_VERSION=0.8.0

# with_llvm=no: no JIT bitcode, so no clang/llvm matching the base image's own build is needed.
RUN apk add --no-cache --virtual .build-deps git build-base \
    && git clone --branch "v${PGVECTOR_VERSION}" --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
    && cd /tmp/pgvector \
    && make with_llvm=no OPTFLAGS="" \
    && make with_llvm=no install \
    && cd / \
    && rm -rf /tmp/pgvector \
    && apk del .build-deps
