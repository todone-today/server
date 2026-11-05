FROM node:24-alpine
# git: npm fetches @todone/sdk from GitHub.
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
# Without BETTER_AUTH_SECRET, make one once and keep it in the data volume so sessions survive restarts.
CMD ["sh", "-c", "export BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-$(cat /data/secret 2>/dev/null || node -e 'process.stdout.write(require(\"crypto\").randomBytes(32).toString(\"hex\"))' | tee /data/secret)} && node scripts/migrate.ts && node src/main.ts"]
