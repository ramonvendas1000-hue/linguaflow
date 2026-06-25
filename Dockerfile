FROM node:20-alpine

WORKDIR /app

# Install root deps
COPY package*.json ./
RUN npm install

# Build client
COPY client/package*.json ./client/
RUN cd client && npm install

COPY . .
RUN cd client && npm run build

# Compile server TypeScript
RUN npx tsc

EXPOSE 4000

CMD ["node", "dist/server/index.js"]
