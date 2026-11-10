FROM node:22-alpine
WORKDIR /app/backend
COPY backend/package*.json ./
COPY backend/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY backend ./
COPY database /app/database
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node","src/server.js"]
