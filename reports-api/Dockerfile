FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY src ./src

EXPOSE 8001
CMD ["npm","start"]

