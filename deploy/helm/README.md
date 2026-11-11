# Yardhand on Kubernetes

A Helm chart: one pod with one volume. Nothing needs setting to start; the instance makes its own keys and you
claim it in the browser.

## Start

```sh
helm install yardhand oci://ghcr.io/escalay/charts/yardhand --namespace yardhand --create-namespace
kubectl -n yardhand logs deploy/yardhand | grep "Setup code"
kubectl -n yardhand port-forward svc/yardhand 8080:80     # then http://localhost:8080/app
```

The chart and the app are released together under the same number; `--version 1.2.3` installs that release. From a
clone, `helm install yardhand deploy/helm/yardhand` does the same.

## Reach it on your own name

```sh
helm upgrade yardhand oci://ghcr.io/escalay/charts/yardhand --reuse-values \
  --set publicHost=gateway.example.com \
  --set ingress.enabled=true --set ingress.host=gateway.example.com --set ingress.className=nginx
```

`publicHost` is the address the gateway hands out in links and OAuth redirects. TLS is your ingress controller's:
name a secret with `ingress.tlsSecret`, or let the controller's default certificate apply.

## Settings

| Value | What |
|---|---|
| `env` | Any setting from [.env.example](../compose/.env.example) as a plain value: `--set env.GATEWAY_TELEMETRY=off` |
| `existingSecret` | A Secret you made whose keys are setting names, for the ones that are secrets (`GATEWAY_MASTER_KEY`, `OPENROUTER_API_KEY`) |
| `persistence.size`, `persistence.storageClass` | The volume: the database, its daily backups and the search index. 2Gi by default |
| `persistence.existingClaim` | A claim of your own instead |
| `image.tag` | Another release than the chart's own |
| `resources`, `nodeSelector`, `tolerations`, `affinity` | As in any chart |
| `startupSeconds` | How long a start may take (300). The first start after an upgrade migrates the data |

## What the pod may do

It runs as a user that isn't root, with a read-only filesystem apart from its volume and `/tmp`, every capability
dropped, and no service account token. It is one pod on purpose: the database is one SQLite file with one writer, so
an upgrade stops the old pod before it starts the new one, and the gateway is down for that moment.

## Update

Settings › Updates says when a newer version is out and gives the command:

```sh
helm upgrade yardhand oci://ghcr.io/escalay/charts/yardhand --version <version> --reuse-values
```

The new version copies the data before it migrates anything. There is no updater on Kubernetes; Helm is the updater.

**If the new version doesn't come up:**

```sh
helm rollback yardhand
```

The old version starts, finds the copy the failed one made, takes it as its data by itself and says so in its log.
What the failed version left is kept as `backups/failed-<version>.sqlite` in the volume.

## Remove it

```sh
helm uninstall yardhand -n yardhand                    # the data stays: the volume claim is kept
kubectl -n yardhand delete pvc yardhand-state          # and deletes the data, backups included
```

## What isn't here

- More than one replica. It would need another database than a SQLite file.
- The usage report says `other` for how it was installed; `helm` joins the list with its next field list.
