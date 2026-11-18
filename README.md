# Software Factory

## Run it on your computer

[docs/install-with-ai.md](docs/install-with-ai.md) holds a prompt for your AI agent that installs it and fills the one `.env` at the repo root. Then `./sf start|stop|restart|status|doctor|logs|autostart` runs the dashboard (https://localhost:3000), the factory for every target in `targets/` and the fixer together.

## Install

1. Install Docker with Compose v2: [Docker Engine](https://docs.docker.com/engine/install/) on Linux, [Docker Desktop](https://docs.docker.com/desktop/) on macOS and Windows. The installer does not install it for you.
2. Get the values in [the Values table](docs/install-with-ai.md#values) ready.
3. Run:

   ```bash
   git clone https://gitlab.example.com/Ceresa/software-factory.git
   cd software-factory && ./install.sh
   ```

   On Windows, run these commands in Git Bash (it comes with [Git for Windows](https://git-scm.com/download/win)) or in WSL2. `install.sh` is a bash script, and cmd and PowerShell cannot run it.

The installer asks for each value, with where to get it, and writes `deploy/.env` (never in git). It then starts the dashboard behind HTTPS and the factory worker (`factory/worker.ts`, seams.yml `ci: local`), which runs each step of a run in a new container. Where those containers run is the answer to "Where tickets run": `machine` (the default) on this machine, `hetzner` on a new Hetzner VM per run that the worker deletes after the run, or `gitlab`, where a GitLab Runner starts one Hetzner VM per CI job in place of the worker (set `ci: gitlab` in seams.yml). Run `./install.sh` again after `git pull` to update. To change a value, edit `deploy/.env` and run it again.

Which values you need depends on where people sign in, which tracker each target uses (`tracker` in its target file) and what runs the factory (`FACTORY_CI`). The installer asks only for the values your answers need. [The Values table in docs/install-with-ai.md](docs/install-with-ai.md#values) lists each one and where to get it. It uses the same names as the local `.env`.

## How it works

See [docs/how-it-works.md](docs/how-it-works.md) for the run, its steps and the switches, and [docs/setup.md](docs/setup.md) for the GitLab and CI set-up.

## Tests

- `pnpm precommit` runs the unit tests and the typecheck of the factory and the dashboard.
- `pnpm e2e` runs the dashboard's Playwright tests.
- `docker compose -f compose.test.yml run --rm test` runs all of them in Linux, in the same image as CI. Only Docker is needed.
