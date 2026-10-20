# Operations

This runbook is for the production deployment in the `money-tracker` namespace of the home cluster. The manifests are in `home-infrastructure/k8s/money-tracker/`. Run the `./deploy.sh` and `scripts/` commands from the root of `home-infrastructure`.

## Manage users

The `mtapi admin` commands run in the API container. They use the `DATABASE_URL` and `PUBLIC_URL` of the pod.

### Invite a user

```sh
kubectl -n money-tracker exec deploy/money-tracker-api -c api -- \
  /mtapi admin invite --email <email> --currency EUR
```

The command prints an invite URL. Send the URL to the user. The user opens it, sets a password and TOTP, and saves the recovery codes. To make an admin user, add `--role admin`.

### Reset TOTP

Use this when a user loses the authenticator app and the recovery codes.

```sh
kubectl -n money-tracker exec deploy/money-tracker-api -c api -- \
  /mtapi admin reset-totp --email <email>
```

The command removes the TOTP secret, revokes all sessions of the user and prints a new invite URL. Send the URL to the user. The user sets up TOTP again through it.

### Revoke sessions

Use this when a user loses a device.

```sh
kubectl -n money-tracker exec deploy/money-tracker-api -c api -- \
  /mtapi admin revoke-sessions --email <email>
```

All devices of the user must log in again.

## Secrets

The secrets are in `k8s/money-tracker/secrets/money-tracker-secrets.yaml`, encrypted with SOPS. To change a value, run:

```sh
scripts/sops-edit.sh k8s/money-tracker/secrets/money-tracker-secrets.yaml
```

Keep a copy of `JWT_PRIVATE_KEY_PEM` and `TOTP_ENC_KEY` in the password manager. Update the copy each time you change a value.

### Rotate the JWT key

1. Make a new key:

   ```sh
   openssl genpkey -algorithm ed25519
   ```

2. Open the secrets file with `scripts/sops-edit.sh`. Replace `JWT_PRIVATE_KEY_PEM` in the Secret `money-tracker-api` with the new key.
3. Apply the secret:

   ```sh
   ./deploy.sh money-tracker upgrade
   ```

4. Restart the API, then PowerSync, so that PowerSync reads the new JWKS:

   ```sh
   kubectl -n money-tracker rollout restart deploy/money-tracker-api
   kubectl -n money-tracker rollout status deploy/money-tracker-api
   kubectl -n money-tracker rollout restart deploy/money-tracker-powersync
   kubectl -n money-tracker rollout status deploy/money-tracker-powersync
   ```

5. Run `/mtapi admin revoke-sessions --email <email>` for each user. All users then log in again.
6. Update the copy in the password manager.

### TOTP_ENC_KEY

Do not rotate `TOTP_ENC_KEY` without a re-encryption step. The API encrypts the TOTP secret of each user with this key. With a different key, no user can log in.

There is no re-encryption command. If the key leaks, do these steps:

1. Replace `TOTP_ENC_KEY` with the output of `openssl rand -base64 32`. Apply the secret and restart the API.
2. Run `/mtapi admin reset-totp --email <email>` for each user.
3. Send each user the new invite URL. The user sets up TOTP again.
4. Update the copy in the password manager.

## Backups

The CronJob `money-tracker-pg-dump` runs each night at 01:30. It writes `/dumps/money-YYYY-MM-DD.dump` (`pg_dump --format=custom`) to the PVC `money-tracker-dumps`. The Longhorn job `daily-backup` copies all volumes to S3 at 02:00 and keeps 14 backups. On the 1st of each month at 04:00, the CronJob `money-tracker-restore-check` restores the newest dump into a test database.

### Restore from a dump

Do not do these steps at 01:30. The PVC `money-tracker-dumps` attaches to one pod at a time, and the dump CronJob uses it then.

1. Stop the API and PowerSync:

   ```sh
   kubectl -n money-tracker scale deploy/money-tracker-api deploy/money-tracker-powersync --replicas=0
   ```

2. Start a restore pod. The network policy lets pods with the label `app: money-tracker-backup` connect to PostgreSQL.

   ```sh
   kubectl -n money-tracker apply -f - <<'YAML'
   apiVersion: v1
   kind: Pod
   metadata:
     name: money-tracker-restore
     namespace: money-tracker
     labels:
       app: money-tracker-backup
   spec:
     restartPolicy: Never
     securityContext:
       runAsNonRoot: true
       runAsUser: 26
       runAsGroup: 26
       fsGroup: 26
     containers:
       - name: restore
         image: ghcr.io/cloudnative-pg/postgresql:17
         command: ["sleep", "3600"]
         env:
           - name: PGHOST
             value: money-tracker-db-rw
           - name: PGUSER
             valueFrom:
               secretKeyRef:
                 name: money-tracker-db-app
                 key: username
           - name: PGPASSWORD
             valueFrom:
               secretKeyRef:
                 name: money-tracker-db-app
                 key: password
         volumeMounts:
           - name: dumps
             mountPath: /dumps
     volumes:
       - name: dumps
         persistentVolumeClaim:
           claimName: money-tracker-dumps
   YAML
   kubectl -n money-tracker wait --for=condition=Ready pod/money-tracker-restore
   ```

3. Find the dump to restore:

   ```sh
   kubectl -n money-tracker exec money-tracker-restore -- ls -l /dumps
   ```

4. Restore the dump into `money`:

   ```sh
   kubectl -n money-tracker exec money-tracker-restore -- \
     pg_restore --clean --if-exists --no-owner --exit-on-error --dbname money /dumps/money-<date>.dump
   ```

5. Remove the PowerSync state, so that PowerSync replicates all data again. Drop the replication slot of PowerSync, then make the storage database again:

   ```sh
   kubectl -n money-tracker exec money-tracker-db-1 -c postgres -- psql -c \
     "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE 'powersync%'"
   kubectl -n money-tracker exec money-tracker-db-1 -c postgres -- psql -c "DROP DATABASE powersync_storage WITH (FORCE)"
   kubectl -n money-tracker exec money-tracker-db-1 -c postgres -- psql -c "CREATE DATABASE powersync_storage OWNER powersync_storage"
   ```

6. Delete the restore pod:

   ```sh
   kubectl -n money-tracker delete pod money-tracker-restore
   ```

7. Start the API and PowerSync:

   ```sh
   kubectl -n money-tracker scale deploy/money-tracker-api deploy/money-tracker-powersync --replicas=1
   ```

8. On each device, open Settings and tap "Reset local data". A device loses the changes that it did not upload before the reset.

### Restore from a Longhorn backup

Use this when the PVC `money-tracker-dumps` is lost or has no good dump. The Longhorn backups are encrypted. Longhorn needs the key in the secret `longhorn-crypto` to restore them.

1. Find the Longhorn volume of the PVC:

   ```sh
   kubectl -n money-tracker get pvc money-tracker-dumps -o jsonpath='{.spec.volumeName}'
   ```

   If the PVC does not exist, find the volume in the Longhorn UI under Backup. The backup labels show the PVC name.

2. In the Longhorn UI, open Backup and select the volume. Select the backup with the date that you need, then click Restore.
3. Set the name to `money-tracker-dumps-restore`. Make sure that Encrypted is on. Click OK and wait until the volume is Detached and Healthy.
4. Open Volume, select `money-tracker-dumps-restore` and click Create PV/PVC. Set the namespace to `money-tracker` and the PVC name to `money-tracker-dumps-restore`.
5. Do the steps in "Restore from a dump". In step 2, change `claimName` to `money-tracker-dumps-restore`.
6. Delete the PVC:

   ```sh
   kubectl -n money-tracker delete pvc money-tracker-dumps-restore
   ```

   Then delete the volume `money-tracker-dumps-restore` in the Longhorn UI.

If the database volume is lost, run `./deploy.sh money-tracker install` to make a new empty cluster. The migrate init container fails until the CNPG operator makes the role `powersync_repl`, and then it runs. When the API is Running, restore a dump as above.

## Self-hosted Mac runner for the iOS e2e tests

The workflow `.github/workflows/ios-e2e.yml` runs each night at 03:00 UTC and on a manual dispatch. It runs on a Mac with the runner labels `self-hosted`, `macOS` and `money-tracker`.

### Requirements

Install these on the Mac before you register the runner:

- Xcode, from the App Store. Open it once and accept the licence.
- An iOS simulator runtime, from Xcode > Settings > Components. The tests use the first available iPhone and iPad simulators. To select others, set `IOS_PHONE_SIMULATOR` and `IOS_TABLET_SIMULATOR` to the simulator names in the runner environment.
- Docker Desktop. Start it, and set it to start when you log in.
- Maestro, with `curl -fsSL "https://get.maestro.mobile.dev" | bash`. Maestro needs Java 17 or newer.
- Node LTS (Node 24), with npm.

Make sure that `docker`, `maestro`, `node`, `npm`, `make` and `xcrun` are on the `PATH` of the runner. The runner reads the `PATH` from the `.path` file in its folder when you install it.

### Register the runner

1. On GitHub, open the repository and go to Settings > Actions > Runners > New self-hosted runner.
2. Select macOS and the architecture of your Mac (ARM64 for Apple silicon).
3. Run the download commands that GitHub shows, in a new folder, for example `~/actions-runner`.
4. Run the configure command that GitHub shows, and add the label:

   ```sh
   ./config.sh --url https://github.com/<owner>/money-tracker --token <token> --labels money-tracker
   ```

   The runner gets the labels `self-hosted` and `macOS` automatically.
5. Install the runner as a service, so that it starts when you log in:

   ```sh
   ./svc.sh install
   ./svc.sh start
   ```

   Keep the user logged in. The iOS simulator and Docker Desktop need a user session.
6. On the Actions tab, select "iOS e2e" and click "Run workflow". Make sure that the run passes.

If a run fails, download the `maestro-artifacts` artifact from the run. It has the Maestro screenshots and logs from `~/.maestro/tests/`.

## Release

The workflow `.github/workflows/release.yml` starts when you push a tag that starts with `v`. It builds `kyosifov/money-tracker-api`, `kyosifov/money-tracker-powersync` and `kyosifov/money-tracker-web` for `linux/amd64` and `linux/arm64`, and pushes them to Docker Hub. The image tag is the git tag. The workflow needs the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.

Do the steps in this order:

1. Tag the release and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

2. Wait until the "Release" workflow passes. Make sure that the three images with the new tag are on Docker Hub.
3. In `home-infrastructure`, change the image tags in `k8s/money-tracker/api.yaml`, `k8s/money-tracker/powersync.yaml` and `k8s/money-tracker/web.yaml` to the new tag.
4. From the root of `home-infrastructure`, run:

   ```sh
   ./deploy.sh money-tracker upgrade
   ```

5. Build the iOS app and install it through TestFlight. This step needs an Apple Developer account and an Expo account. Install EAS CLI with `npm install -g eas-cli`, then log in with `eas login`. From the `app` folder, run:

   ```sh
   eas build --platform ios --profile production
   eas submit --platform ios --latest
   ```

   When the build is on TestFlight, install it on the iPhone or iPad from the TestFlight app.

The `production` profile in `app/eas.json` sets `EXPO_PUBLIC_API_URL=https://money.kyosifov.com` and `EXPO_PUBLIC_POWERSYNC_URL=https://money-sync.kyosifov.com`. The `development` profile builds for the iOS simulator. The `preview` profile builds for internal distribution to registered devices.
