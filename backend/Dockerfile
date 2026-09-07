FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
COPY .npmrc ./
RUN npm ci --omit=dev --omit=peer && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./dist/migrations
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
