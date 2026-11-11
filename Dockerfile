# Demo image: builds the plugin, installs it into the demo Strapi app, runs it.
# Railway builds this automatically; locally: docker build -t supertext-strapi . && docker run -p 1337:1337 --env-file demo/.env supertext-strapi

FROM node:26-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
 && npm pack --pack-destination demo \
 && mv demo/strapi-plugin-supertext-translation-*.tgz demo/plugin.tgz
WORKDIR /src/demo
# Installing the tarball explicitly refreshes the plugin even if the lockfile has an older one.
RUN npm install ./plugin.tgz --no-audit --no-fund \
 && NODE_ENV=production npm run build

FROM node:26-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/demo ./
RUN mkdir -p public/uploads
EXPOSE 1337
CMD ["npm", "run", "start"]
