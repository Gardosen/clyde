FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY server ./server
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production CLYDE_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8484
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8484/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
