FROM public.ecr.aws/docker/library/node:20-alpine

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server.js .
COPY public ./public
# build-metadata.json is written here by buildspec.yml BEFORE this Dockerfile builds
COPY build-metadata.json .

EXPOSE 80
CMD ["node", "server.js"]
