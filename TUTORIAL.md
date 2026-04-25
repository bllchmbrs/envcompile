# envcompile Tutorial

This tutorial walks through a complete local example:

1. Create reusable source env files.
2. Encrypt those source files with dotenvx.
3. Store the source private keys outside the source env tree.
4. Configure an `api` deployment target.
5. Validate and compare environments.
6. Compile a deployment-specific encrypted env file.
7. Decrypt the compiled file to prove the deployment bundle works.
8. Change one source file and recompile.

The example uses fake secrets and a local `./tutorial_secrets` folder so it is safe to run without touching your real `~/secrets/project` directory.

## Prerequisites

Run these commands from the root of the `envcompile` repository.

```bash
npm install
```

Make the local CLI available as `envcompile`:

```bash
npm link
```

Check both CLIs:

```bash
envcompile --help
npx dotenvx --help
```

## Start Clean

This tutorial writes only example files. Remove any previous tutorial run:

```bash
rm -rf source_env_vars compiled_env tutorial_secrets envcompile.config.yaml .env.keys
```

Create the folder layout:

```bash
mkdir -p source_env_vars/dev source_env_vars/staging source_env_vars/prod
mkdir -p tutorial_secrets/source_env_vars/dev
mkdir -p tutorial_secrets/source_env_vars/staging
mkdir -p tutorial_secrets/source_env_vars/prod
mkdir -p tutorial_secrets/targets/dev tutorial_secrets/targets/staging tutorial_secrets/targets/prod
```

## Create Plaintext Source Files

Each environment has separate source files for separate products or systems.

Create the Stripe files:

```bash
cat > source_env_vars/dev/.env.stripe <<'EOF'
STRIPE_SECRET_KEY=sk_test_dev_123
STRIPE_PUBLISHABLE_KEY=pk_test_dev_123
EOF

cat > source_env_vars/staging/.env.stripe <<'EOF'
STRIPE_SECRET_KEY=sk_test_staging_456
STRIPE_PUBLISHABLE_KEY=pk_test_staging_456
EOF

cat > source_env_vars/prod/.env.stripe <<'EOF'
STRIPE_SECRET_KEY=sk_live_prod_789
STRIPE_PUBLISHABLE_KEY=pk_live_prod_789
EOF
```

Create the Cloudflare files:

```bash
cat > source_env_vars/dev/.env.cloudflare <<'EOF'
CLOUDFLARE_API_TOKEN=cf_dev_token_123
CLOUDFLARE_ZONE_ID=dev-zone-123
EOF

cat > source_env_vars/staging/.env.cloudflare <<'EOF'
CLOUDFLARE_API_TOKEN=cf_staging_token_456
CLOUDFLARE_ZONE_ID=staging-zone-456
EOF

cat > source_env_vars/prod/.env.cloudflare <<'EOF'
CLOUDFLARE_API_TOKEN=cf_prod_token_789
CLOUDFLARE_ZONE_ID=prod-zone-789
EOF
```

At this point the source files are plaintext. The next section encrypts them.

## Encrypt Source Files

For each source file, run `npx dotenvx encrypt`, move the generated `.env.keys` file into `tutorial_secrets`, then remove `.env.keys` from the repo root.

```bash
npx dotenvx encrypt -f source_env_vars/dev/.env.stripe
mv .env.keys tutorial_secrets/source_env_vars/dev/.env.stripe.keys

npx dotenvx encrypt -f source_env_vars/dev/.env.cloudflare
mv .env.keys tutorial_secrets/source_env_vars/dev/.env.cloudflare.keys

npx dotenvx encrypt -f source_env_vars/staging/.env.stripe
mv .env.keys tutorial_secrets/source_env_vars/staging/.env.stripe.keys

npx dotenvx encrypt -f source_env_vars/staging/.env.cloudflare
mv .env.keys tutorial_secrets/source_env_vars/staging/.env.cloudflare.keys

npx dotenvx encrypt -f source_env_vars/prod/.env.stripe
mv .env.keys tutorial_secrets/source_env_vars/prod/.env.stripe.keys

npx dotenvx encrypt -f source_env_vars/prod/.env.cloudflare
mv .env.keys tutorial_secrets/source_env_vars/prod/.env.cloudflare.keys
```

Inspect one encrypted source file:

```bash
sed -n '1,20p' source_env_vars/prod/.env.stripe
```

You should see a `DOTENV_PUBLIC_KEY` header and encrypted values:

```text
DOTENV_PUBLIC_KEY="..."
STRIPE_SECRET_KEY="encrypted:..."
STRIPE_PUBLISHABLE_KEY="encrypted:..."
```

Inspect one key file:

```bash
cat tutorial_secrets/source_env_vars/prod/.env.stripe.keys
```

You should see a dotenvx private key entry. This file is required to decrypt the encrypted source file and should not be committed in a real project.

## Create envcompile Config

Create `envcompile.config.yaml`:

```bash
cat > envcompile.config.yaml <<'EOF'
version: 1

sourceDir: source_env_vars
keysDir: tutorial_secrets

environments:
  - dev
  - staging
  - prod

keyFilePatterns:
  source: source_env_vars/{env}/.env.{source}.keys
  target: targets/{env}/.env.{target}.keys

targets:
  api:
    description: API deployment bundle
    output: compiled_env/{env}/.env.api
    keyFile: targets/{env}/.env.api.keys
    sources:
      - stripe
      - cloudflare
    required:
      - STRIPE_SECRET_KEY
      - STRIPE_PUBLISHABLE_KEY
      - CLOUDFLARE_API_TOKEN
      - CLOUDFLARE_ZONE_ID
    duplicatePolicy: error
    ordering: config

  web:
    description: Web deployment bundle
    output: compiled_env/{env}/.env.web
    keyFile: targets/{env}/.env.web.keys
    sources:
      - stripe
    required:
      - STRIPE_PUBLISHABLE_KEY
    duplicatePolicy: error
    ordering: config
EOF
```

List what the CLI sees:

```bash
envcompile list
envcompile targets
envcompile sources
```

Expected shape:

```text
Environments: dev, staging, prod
Targets: api, web
```

## Validate Everything

Run a full validation:

```bash
envcompile check
```

Expected output:

```text
ok api/dev
ok api/staging
ok api/prod
ok web/dev
ok web/staging
ok web/prod
```

Compare the composed `api` target across environments:

```bash
envcompile compare api
```

Expected output shape:

```text
Key                     dev      staging  prod
---                     ---      -------  ----
CLOUDFLARE_API_TOKEN    present  present  present
CLOUDFLARE_ZONE_ID      present  present  present
STRIPE_PUBLISHABLE_KEY  present  present  present
STRIPE_SECRET_KEY       present  present  present
```

Compare just one source across environments:

```bash
envcompile compare --source stripe
```

Lint for duplicate key names across the sources that make up each target:

```bash
envcompile lint
envcompile lint api --env prod --strict
```

`lint` warns when two sources define the same key, such as two Stripe API key entries with the same env var name. With `--strict`, duplicate key names fail the command. If a target intentionally allows duplicates with `duplicatePolicy: first-wins` or `duplicatePolicy: last-wins`, the order of `sources` in the target config is the compilation hierarchy.

## Compile a Deployment Env File

First do a dry run:

```bash
envcompile compile api --env prod --dry-run
```

Expected output:

```text
Dry run ok: api/prod
Would write .../compiled_env/prod/.env.api
Would write .../tutorial_secrets/targets/prod/.env.api.keys
```

Now compile the production API target:

```bash
envcompile compile api --env prod --print-key
```

Expected output shape:

```text
Compiled api/prod
Env:  .../compiled_env/prod/.env.api
Keys: .../tutorial_secrets/targets/prod/.env.api.keys
DOTENV_PRIVATE_KEY_API="..."
```

The compiled file is encrypted:

```bash
sed -n '1,30p' compiled_env/prod/.env.api
```

You should see encrypted values for both Stripe and Cloudflare keys.

The compiled key file is separate:

```bash
cat tutorial_secrets/targets/prod/.env.api.keys
```

In a real deployment, this target key is what you would place in your deployment secret store.

## Decrypt the Compiled Target

Load the generated private key and decrypt the compiled env file:

```bash
set -a
. tutorial_secrets/targets/prod/.env.api.keys
set +a

npx dotenvx decrypt -f compiled_env/prod/.env.api --stdout
```

Expected decrypted values:

```text
STRIPE_SECRET_KEY="sk_live_prod_789"
STRIPE_PUBLISHABLE_KEY="pk_live_prod_789"
CLOUDFLARE_API_TOKEN="cf_prod_token_789"
CLOUDFLARE_ZONE_ID="prod-zone-789"
```

This proves the deployment bundle is self-contained: it has the encrypted compiled file plus one deployment-specific private key.

## Run a Program With the Compiled Target

Decryption is a useful proof, but deployments usually do not print secrets. They start a process with the compiled env file loaded.

Create a tiny example program:

```bash
cat > run_my_thing.py <<'EOF'
import os

print("stripe key:", os.environ["STRIPE_SECRET_KEY"])
print("cloudflare zone:", os.environ["CLOUDFLARE_ZONE_ID"])
EOF
```

Run the program through dotenvx with the compiled encrypted env file and its generated target key file:

```bash
npm exec -- dotenvx run \
  -f compiled_env/prod/.env.api \
  -fk tutorial_secrets/targets/prod/.env.api.keys \
  -- python3 run_my_thing.py
```

Expected output:

```text
stripe key: sk_live_prod_789
cloudflare zone: prod-zone-789
```

That is the end-to-end deployment shape:

1. Commit or ship `compiled_env/prod/.env.api`.
2. Store `DOTENV_PRIVATE_KEY_API` from `tutorial_secrets/targets/prod/.env.api.keys` in the runtime secret store.
3. Start your real process with `dotenvx run -f compiled_env/prod/.env.api -- your_command`.

When the runtime already exports `DOTENV_PRIVATE_KEY_API`, you can omit `-fk`.

## Inspect Without Showing Values

By default, `inspect` shows names but not secret values:

```bash
envcompile inspect api --env prod
```

To intentionally show values:

```bash
envcompile inspect api --env prod --show-values --yes
```

## Change One Source and Recompile

To rotate or change a value, update the single source file that owns it.

First, decrypt the production Stripe source to stdout so you can see the current value:

```bash
set -a
. tutorial_secrets/source_env_vars/prod/.env.stripe.keys
set +a

npx dotenvx decrypt -f source_env_vars/prod/.env.stripe --stdout
```

Change the production Stripe secret in the encrypted source file:

```bash
npx dotenvx set STRIPE_SECRET_KEY sk_live_prod_rotated_001 -f source_env_vars/prod/.env.stripe
```

Recompile the API production target:

```bash
envcompile compile api --env prod --force --print-key
```

Decrypt the compiled target again:

```bash
set -a
. tutorial_secrets/targets/prod/.env.api.keys
set +a

npx dotenvx decrypt -f compiled_env/prod/.env.api --stdout
```

Now the compiled deployment env contains:

```text
STRIPE_SECRET_KEY="sk_live_prod_rotated_001"
```

The important part: only `source_env_vars/prod/.env.stripe` needed to change. Any target that includes `stripe` can now be recompiled from the same source.

## Duplicate Key Example

`envcompile` catches accidental key collisions.

Decrypt the production Cloudflare source in place:

```bash
set -a
. tutorial_secrets/source_env_vars/prod/.env.cloudflare.keys
set +a

npx dotenvx decrypt -f source_env_vars/prod/.env.cloudflare
```

Add a duplicate Stripe key to the Cloudflare source:

```bash
cat >> source_env_vars/prod/.env.cloudflare <<'EOF'
STRIPE_SECRET_KEY=wrong_owner
EOF
```

Re-encrypt the Cloudflare source. This keeps the tutorial simple by generating a fresh source key for the changed file.

```bash
rm -f .env.keys
npx dotenvx encrypt -f source_env_vars/prod/.env.cloudflare
mv .env.keys tutorial_secrets/source_env_vars/prod/.env.cloudflare.keys
```

Run validation:

```bash
envcompile check api --env prod
```

Expected failure shape:

```text
fail api/prod
  duplicate STRIPE_SECRET_KEY: stripe and cloudflare
envcompile: check failed
```

Fix it by decrypting the Cloudflare source, removing the duplicate key, and re-encrypting:

```bash
set -a
. tutorial_secrets/source_env_vars/prod/.env.cloudflare.keys
set +a

npx dotenvx decrypt -f source_env_vars/prod/.env.cloudflare
perl -0pi -e 's/\nSTRIPE_SECRET_KEY=wrong_owner\n/\n/' source_env_vars/prod/.env.cloudflare
rm -f .env.keys
npx dotenvx encrypt -f source_env_vars/prod/.env.cloudflare
mv .env.keys tutorial_secrets/source_env_vars/prod/.env.cloudflare.keys
```

Validation passes again:

```bash
envcompile check api --env prod
```

## Cleanup

Remove the tutorial files:

```bash
rm -rf source_env_vars compiled_env tutorial_secrets envcompile.config.yaml .env.keys
```

## What This Demonstrates

- Source env files are encrypted and can be committed.
- Source private keys stay outside the source env tree.
- Targets declare which sources they need.
- `envcompile` decrypts sources, validates the combined key set, writes one compiled env file, and encrypts it with a new deployment-specific key.
- Changing a source secret requires updating only that source, then recompiling any affected targets.
