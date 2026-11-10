# CORDEX Node.js backend
# package-lock.json dependencies require Node.js >= 20.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=7070 \
    HOST=0.0.0.0

WORKDIR /app

# Install exactly the dependency versions recorded in package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy backend, frontend static assets, and required application modules.
COPY --chown=node:node . .

# The application writes uploaded files here; mount a Docker volume at runtime.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

USER node

EXPOSE 7070

CMD ["node", "web.js"]
