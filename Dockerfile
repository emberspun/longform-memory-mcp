# longform-memory-mcp
#
# ⚠️ Mount a volume or your book is forgotten when the container stops.
# This server stores memory in files by design; a container without a volume
# hands every session an empty document, which looks exactly like a bug.
#
#   docker run -i --rm \
#     -v longform-memory:/data \
#     -e LONGFORM_MEMORY_PROJECT=my-novel \
#     emberspun/longform-memory-mcp
#
# stdin must stay open (`-i`): stdio is the transport.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Memory lives outside the image so a `docker pull` never overwrites a book.
ENV LONGFORM_MEMORY_HOME=/data

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node

ENTRYPOINT ["node", "/app/dist/bin.js"]
