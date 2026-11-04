# Fly.io・Koyeb など、Docker で動かす場所に置くとき用
FROM node:20-alpine
WORKDIR /app
COPY package.json server.js index.html ./
ENV PORT=8080 RC_HOSTED=1
EXPOSE 8080
CMD ["node", "server.js"]
