FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node server.mjs plugin.json LICENSE ./
COPY --chown=node:node packs ./packs

# Ensure ~/.gemini exists and is writable for non-root container runs
RUN mkdir -p /home/node/.gemini && chown -R node:node /home/node/.gemini

ENV NODE_ENV=production
ENV PLUGIN_ROOT=/app
# Expose MCP tools during headless container introspection (e.g. Glama checks)
# while preserving automatic Desktop/CLI host detection for native local installs.
ENV AGY_MEME_HOST=desktop

USER node

CMD ["node", "server.mjs"]
