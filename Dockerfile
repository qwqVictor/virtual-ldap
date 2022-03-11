FROM node:16.14.0-alpine

WORKDIR /app
COPY . /app
COPY config.example.js /app/config.js

RUN npm ci

CMD [ "node","index.js" ]