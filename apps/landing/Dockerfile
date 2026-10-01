FROM node:24-alpine AS build
WORKDIR /app
RUN npm install --global pnpm@12.8.1
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @xrio/landing build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=build --chown=node:node /app/apps/landing/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/landing/.next/static ./apps/landing/.next/static
COPY --from=build --chown=node:node /app/apps/landing/public ./apps/landing/public
USER node
EXPOSE 3000
CMD ["node", "apps/landing/server.js"]
