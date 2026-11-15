# Demo image for MCP directories (such as Glama) that start a server and ask for its tools.
# It runs imsg-mcp in local (stdio) mode against the test stand-in for imsg, with sample
# conversations. It cannot read or send real messages: that needs a Mac signed in to
# Messages. For real use, see the README.
#
#   docker build -f deploy/demo/Dockerfile -t imsg-mcp-demo .
#   docker run -i --rm imsg-mcp-demo
FROM oven/bun:1.4.4-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY test/fixtures/stub-imsg.ts test/helpers/fixtures.ts ./demo/

# Sample conversations, a stand-in `imsg` on PATH, and a config with no Messages.app to watch.
RUN bun -e 'import { fixtureDb } from "./demo/fixtures.ts"; await Bun.write("demo/chatdb.json", JSON.stringify(fixtureDb()));' \
  && printf '#!/bin/sh\nexec bun /app/demo/stub-imsg.ts "$@"\n' > /usr/local/bin/imsg \
  && chmod 755 /usr/local/bin/imsg \
  && printf '[health]\nrelaunch_messages = false\n' > demo/config.toml \
  && chmod 600 demo/config.toml

ENV IMSG_MCP_CONFIG=/app/demo/config.toml \
  IMSG_MCP_STATE_DIR=/tmp/imsg-mcp \
  IMSG_MCP_LOG_DIR=/tmp/imsg-mcp/logs \
  STUB_IMSG_DB=/app/demo/chatdb.json

ENTRYPOINT ["bun", "src/cli.ts", "stdio"]
