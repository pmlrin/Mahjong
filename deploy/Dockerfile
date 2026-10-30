FROM node:24-bookworm-slim
WORKDIR /app
COPY deploy/runtime-package.json ./package.json
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY dist-server/ ./dist-server/
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "dist-server/backend/src/server.js"]
