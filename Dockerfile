FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libsodium-dev \
    libopus-dev \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

# Railway Volume 마운트 포인트 (영구 데이터 저장)
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
