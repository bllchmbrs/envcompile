# envcompile

`envcompile` composes encrypted dotenvx source files into deployment-specific encrypted env files.

It is meant for repositories that keep reusable sources in source control as encrypted `.env.<source>` files, while keeping their private dotenvx keys outside the repository.

## Repository layout

```text
source_env_vars/
  dev/
    .env.stripe
    .env.cloudflare
  staging/
    .env.stripe
    .env.cloudflare
  prod/
    .env.stripe
    .env.cloudflare
```

Private keys live outside the repo:

```text
~/secrets/my-app/
  dev/.env.stripe.keys
  dev/.env.cloudflare.keys
```

## Install

```bash
npm install
npm link
```

`envcompile` depends on `@dotenvx/dotenvx` and uses the bundled dotenvx binary by default. You can still pass `--dotenvx <bin>` when you want to use a specific executable.

## Config

Create `envcompile.config.yaml`:

```yaml
version: 1

sourceDir: source_env_vars
keysDir: ~/secrets/my-app

environments:
  - dev
  - staging
  - prod

keyFilePatterns:
  source: '{env}/.env.{source}.keys'

sources:
  - stripe
  - cloudflare

targets:
  api:
    output: compiled_env/{env}/.env.api
    sources:
      - stripe
      - cloudflare
    required:
      - STRIPE_SECRET_KEY
      - CLOUDFLARE_API_TOKEN
    duplicatePolicy: error
    ordering: config
```

Top-level `sources` and `publicSources` are optional. Use them for sources you want configured before they are attached to a target. Target-level `sources` and `publicSources` still define what gets compiled into each target.

`output` is required and can also be a per-environment map instead of a template:

```yaml
targets:
  api:
    output:
      dev: compiled_env/dev/.env.api
      staging: compiled_env/staging/.env.api
      prod: compiled_env/prod/.env.api
    sources:
      - stripe
      - cloudflare
```

Compiled target key files default to the output path plus `.keys`, so `compiled_env/prod/.env.api` writes its key file next to it at `compiled_env/prod/.env.api.keys`. Add `keyFile` only when you want an explicit override:

```yaml
targets:
  api:
    output: deploy/{env}/.env
    keyFile: deploy-keys/{env}/.env.keys
    sources:
      - stripe
```

Source files resolve to:

```text
{sourceDir}/{env}/.env.{source}
```

Source key files resolve to:

```text
{keysDir}/{env}/.env.{source}.keys
```

Target key files default to the target output path plus `.keys`:

```text
compiled_env/{env}/.env.{target}.keys
```

## Commands

Initialize a starter config:

```bash
envcompile init
envcompile init --project my-app
```

`init` asks for a project name when run interactively and defaults to the current folder name. The project name is used for `keysDir`, such as `~/secrets/my-app`, and the starter config begins with `dev` and `prod` environments and no targets or sources.

List configured environments, targets, and sources:

```bash
envcompile list
envcompile targets
envcompile sources
```

Add another environment and create its source directories:

```bash
envcompile env add build
```

List and update targets:

```bash
envcompile targets list
envcompile targets add api
envcompile targets add web --output 'compiled_env/{env}/.env.web'
envcompile targets remove old-api
```

`targets add` creates a target with no sources. Attach existing configured sources afterward with `envcompile connect <target> <source...>`.

List and update configured sources, or attach them to targets:

```bash
envcompile sources list
envcompile sources list --target api
envcompile sources add billing
envcompile sources add stripe --target api
envcompile sources add defaults --public
envcompile sources add defaults --target api --public
envcompile sources remove billing
envcompile sources remove defaults --target api --public
```

`sources add` creates an empty `.env.<source>` file for each configured environment under `privateDir` or `publicDir`, without overwriting existing files. Private key files are created later when you set a private secret or encrypt the source.

Connect already configured sources to targets with validation:

```bash
envcompile sources add stripe
envcompile sources add cloudflare
envcompile sources add defaults --public
envcompile targets add api
envcompile connect api stripe cloudflare
envcompile connect api defaults --public
```

`connect` requires the target and source to already exist in the config. It does not create source files.

Set and unset values without editing config or source files by hand:

```bash
printf '%s\n' 'sk_live_...' | envcompile secret set stripe STRIPE_SECRET_KEY --env prod --private --stdin
printf '%s\n' 'info' | envcompile secret set defaults LOG_LEVEL --env prod --public --stdin
envcompile secret unset stripe OLD_SECRET --env prod --private
```

Without `--stdin`, `secret set` prompts for the value without echoing it. Secret values are not accepted as positional arguments, which helps keep them out of shell history.

Compile a target:

```bash
envcompile compile api --env prod
```

This decrypts each configured source with its key file, combines the values, writes the encrypted target env file, and writes the generated target private key file outside the repo.

Preview a compile without writing output:

```bash
envcompile compile api --env prod --dry-run
```

Overwrite existing compiled output and key files:

```bash
envcompile compile api --env prod --force
```

Print the generated deployment key after compilation:

```bash
envcompile compile api --env prod --print-key
```

Validate source files, key files, duplicate handling, and required variables:

```bash
envcompile check
envcompile check api
envcompile check api --env staging
```

Warn when two sources for a target define the same key:

```bash
envcompile lint
envcompile lint api --env prod
envcompile lint api --env prod --strict
```

`lint` warns about duplicate keys even when a target allows duplicates with `duplicatePolicy`.
With `--strict`, duplicate keys fail the command.

Compare the composed key set across environments:

```bash
envcompile compare api
envcompile compare api --env dev,staging,prod
```

Compare one source across environments:

```bash
envcompile compare --source stripe
```

Validate that source files, key files, and target output paths are correctly configured:

```bash
envcompile validate
```

Encrypt source files that are not yet encrypted:

```bash
envcompile encrypt
envcompile encrypt stripe
envcompile encrypt stripe --env prod
```

Files that are already encrypted are skipped.

Decrypt source files in-place for editing:

```bash
envcompile decrypt
envcompile decrypt stripe
envcompile decrypt stripe --env prod
```

Files that are already decrypted are skipped.

Inspect a target without showing secret values:

```bash
envcompile inspect api --env prod
```

Showing values is intentionally noisy:

```bash
envcompile inspect api --env prod --show-values --yes
```

Install a pre-commit hook to block unencrypted `.env` files from being committed:

```bash
envcompile pre-commit
```

If a pre-commit hook already exists, use `--force` to overwrite it:

```bash
envcompile pre-commit --force
```

Update `.gitignore` in source directories to ignore `.env.keys` files:

```bash
envcompile gitignore
```

## Duplicate policy

Each target can choose one duplicate policy:

- `error`: duplicate keys fail validation.
- `first-wins`: keep the first source value from the target's `sources` order.
- `last-wins`: keep the last source value from the target's `sources` order.

When duplicates are allowed, the order of `sources` in the target config is the compilation hierarchy.
Run `envcompile lint --strict` in CI if duplicate key names should never be allowed.

## Safety notes

- Source private keys and generated target key files should not be committed.
- `secret set` preserves existing source private keys and stores a backup under `{keysDir}/.envcompile-backups/` before changing an existing private source.
- `compile` refuses to overwrite existing output or key files unless `--force` is passed.
- Plaintext combined env content is written only to a temporary file, then removed after encryption.
- The private key name printed by `--print-key` is the exact key generated by dotenvx for the target filename.

## License

MIT
