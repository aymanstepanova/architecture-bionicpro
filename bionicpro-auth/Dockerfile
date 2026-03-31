FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8000

CMD ["npm","start"]

