# Hosted Insyte MCP server (HTTP). Build: docker build -t insyte-mcp .
# Run:   docker run -p 8080:8080 --env-file hosted.env insyte-mcp   (see docs/hosted.md)
#
# Node 24 is the Active LTS line (LTS since October 2025, security fixes into April 2028), and
# the code needs only Node >= 20. The tag is pinned to an exact version so a rebuild cannot
# change the runtime unannounced. Pin the image digest too once Accent's registry is chosen.
# [UNVERIFIED] This file has never been built: Docker was not available where it was written,
# and the exact tag below was not checked against the registry.
ARG NODE_IMAGE=node:24.11.1-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production dependencies only, so the final image carries no compiler.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    INSYTE_HTTP_HOST=0.0.0.0 \
    INSYTE_HTTP_PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The node image ships an unprivileged "node" user.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.INSYTE_HTTP_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Dev auth refuses to start on 0.0.0.0, so INSYTE_HTTP_AUTH must be oauth here.
CMD ["node", "dist/http.js"]
