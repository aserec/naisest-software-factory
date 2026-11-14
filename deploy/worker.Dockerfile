# The factory worker (factory/worker.ts): the CI job image (runner/Dockerfile, the `runner` context in compose.yml) plus
# this repo. The same image runs each step in its own container, so the code a step runs is the image's, never a step's.
FROM runner
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# The Docker CLI starts the step containers (over ssh for a Hetzner VM); ssh-keygen makes each VM's keys.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/* \
 && docker --version && ssh -V
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json dashboard/
RUN pnpm install --frozen-lockfile --filter software-factory
COPY . .
# The secret, queue and runs dirs in the checkout's .cache (factory/repo.ts STATE_DIR).
RUN mkdir -p /app/.cache/tmp /app/.cache/queue /app/.cache/runs && chmod 700 /app/.cache/tmp
CMD ["node", "--import", "tsx", "factory/worker.ts"]
