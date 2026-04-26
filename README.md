# envcompile

`envcompile` composes encrypted dotenvx source files into deployment-specific encrypted env files.

It is meant for repositories that keep reusable secret groups in source control as encrypted `.env.<source>` files, while keeping their private dotenvx keys outside the repository.

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
~/secrets/project/
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
keysDir: ~/secrets/project

environments:
  - dev
  - staging
  - prod

keyFilePatterns:
  source: '{env}/.env.{source}.keys'
  target: compiled_env/{env}/.env.{target}.keys

targets:
  api:
    output: compiled_env/{env}/.env.api
    keyFile: compiled_env/{env}/.env.api.keys
    sources:
      - stripe
      - cloudflare
    required:
      - STRIPE_SECRET_KEY
      - CLOUDFLARE_API_TOKEN
    duplicatePolicy: error
    ordering: config
```

`output` and `keyFile` can also be per-environment maps instead of templates:

```yaml
targets:
  api:
    output:
      dev: compiled_env/dev/.env.api
      staging: compiled_env/staging/.env.api
      prod: compiled_env/prod/.env.api
    keyFile:
      dev: compiled_env/dev/.env.api.keys
      prod: compiled_env/prod/.env.api.keys
    sources:
      - stripe
      - cloudflare
```

Source files resolve to:

```text
{sourceDir}/{env}/.env.{source}
```

Source key files resolve to:

```text
{keysDir}/{env}/.env.{source}.keys
```

Target key files resolve relative to the config directory (next to the output file):

```text
compiled_env/{env}/.env.{target}.keys
```

## Commands

Initialize a sample config:

```bash
envcompile init
```

List configured environments and targets:

```bash
envcompile list
envcompile targets
envcompile sources
```

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

Update `.gitignore` to ignore `.env.keys` files:

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
- `compile` refuses to overwrite existing output or key files unless `--force` is passed.
- Plaintext combined env content is written only to a temporary file, then removed after encryption.
- The private key name printed by `--print-key` is the exact key generated by dotenvx for the target filename.

## License

MIT
