FROM eclipse-temurin:8-jre AS j8
FROM eclipse-temurin:17-jre AS j17
FROM eclipse-temurin:21-jre AS j21

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=j8 /opt/java/openjdk /opt/java8
COPY --from=j17 /opt/java/openjdk /opt/java17
COPY --from=j21 /opt/java/openjdk /opt/java21

WORKDIR /app
COPY server.js index.html ./
ENV DATA_DIR=/data
EXPOSE 8080 25565
CMD ["node", "server.js"]
