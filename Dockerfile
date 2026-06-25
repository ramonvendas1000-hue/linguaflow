FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npx tsc

EXPOSE 4000

CMD ["node", "dist/server/index.js"]
