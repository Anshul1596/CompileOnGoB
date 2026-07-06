# Backend image with compilers/interpreters needed by compile-run
# Deploy this on Render, Railway, Fly.io, or any normal Docker host —
# no privileged containers / Docker-in-Docker required (unlike Piston).
FROM node:18-bullseye

# Install language toolchains: python3, gcc/g++ (c/cpp), openjdk (java)
RUN apt-get update && apt-get install -y \
    python3 \
    gcc \
    g++ \
    default-jdk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV EXECUTOR=compile-run
ENV PORT=5000
EXPOSE 5000

CMD ["node", "server.js"]
