# The image every factory job runs in. The job-image job in .gitlab-ci.yml builds it on main and prints its digest.
# Put that digest in the .factory image in .gitlab-ci.yml and in the jobImage of every targets/*.yml.
FROM node:22-bookworm@sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd
# jq runs the command guard, unzip reads the run artifacts, and the sandbox needs bubblewrap, socat and ripgrep on Linux.
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq unzip bubblewrap socat ripgrep \
 && rm -rf /var/lib/apt/lists/*
# npm puts both CLIs in /usr/local/bin, which is on the fixed PATH of every factory command.
RUN npm install -g @anthropic-ai/claude-code@2.1.316 @earendil-works/pi-coding-agent@1.4.0 \
 && npm cache clean --force
# Chromium for the before and after screenshots. Keep this version equal to playwright in react_frontend/apps/web/package.json: bump both together.
# The screenshot line fails the build if the browser cannot start. /ms-playwright must be readable by every user the job runs as.
RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx -y playwright@1.62.1 install --with-deps chromium \
 && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright npx -y playwright@1.62.1 screenshot about:blank /tmp/check.png \
 && rm /tmp/check.png \
 && chmod -R a+rX /ms-playwright \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*
# The build fails here if a tool is missing.
RUN claude --version && pi --version && jq --version && bwrap --version && rg --version && socat -V >/dev/null && unzip -v >/dev/null
