# The factory worker: the CI job image (runner/Dockerfile, the `runner` context in compose.yml) plus this repo.
# It runs local-factory.sh in the foreground: every minute it polls GitLab and runs each ready ticket.
FROM runner
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json dashboard/
RUN pnpm install --frozen-lockfile --filter software-factory
COPY . .
CMD ["./local-factory.sh", "run"]
