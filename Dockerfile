FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=8080 DATA_PATH=/app/data/tickets.sqlite
EXPOSE 8080
CMD ["node", "src/server.ts"]
