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
# The build fails here if a tool is missing.
RUN claude --version && pi --version && jq --version && bwrap --version && rg --version && socat -V >/dev/null && unzip -v >/dev/null
