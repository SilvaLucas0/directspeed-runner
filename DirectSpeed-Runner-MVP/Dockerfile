FROM mcr.microsoft.com/playwright:v1.54.2-noble
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production DATA_DIR=/data HEADLESS=true
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8787
CMD ["npm","start"]
