# Debian (glibc) base: the FBX2glTF binary used by /convert
# needs glibc, and assimp-utils (used by /export/fbx) comes
# from Debian packages.
FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends assimp-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
EXPOSE 2567
CMD ["node", "src/index.mjs"]
