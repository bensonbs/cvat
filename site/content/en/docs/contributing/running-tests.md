---
title: 'Running tests'
linkTitle: 'Running tests'
weight: 11
description: 'Instructions on how to run all existence tests.'
---

# E2E tests

**Initial steps**:
1. Run CVAT instance:
   ```
   docker compose \
             --env-file="tests/python/social_auth/.env" \
             -f docker-compose.yml \
             -f docker-compose.dev.yml \
             -f components/serverless/docker-compose.serverless.yml \
             -f tests/docker-compose.minio.yml \
             -f tests/docker-compose.file_share.yml \
             -f tests/python/social_auth/docker-compose.yml up -d
   ```
1. Add test user in CVAT:
   ```
   docker exec -i cvat_server \
             /bin/bash -c \
             "echo \"from django.contrib.auth.models import User; User.objects.create_superuser('admin', 'admin@localhost.company', '12qwaszx')\" | python3 ~/manage.py shell"
   ```
1. Install npm dependencies:
   ```
   cd tests
   yarn --frozen-lockfile
   ```

**Running tests**

```
yarn run cypress:run:chrome
yarn run cypress:run:chrome:canvas3d
```

# REST API, SDK and CLI tests

**Initial steps**

1. Follow [this guide](/site/content/en/docs/api_sdk/sdk/developer-guide/) to prepare
   `cvat-sdk` and `cvat-cli` source code
1. Install all necessary requirements before running REST API tests:
   ```
   pip install -r ./tests/python/requirements.txt
   pip install -e ./cvat-sdk
   pip install -e ./cvat-cli
   ```
1. Stop any other CVAT containers which you run previously. They keep ports
which are used by containers for the testing system.

**Running tests**

Run all REST API tests:

```
pytest ./tests/python
```

This command will automatically start all necessary docker containers.

If you want to start/stop these containers without running tests
use special options for it:

```
pytest ./tests/python --start-services
pytest ./tests/python --stop-services
```

If you need to rebuild your CVAT images add `--rebuild` option:
```
pytest ./tests/python --rebuild
```

**Debugging**

Currently, this is only supported in deployments based on Docker Compose,
which should be enough to fix errors arising in REST API tests.

To debug a server deployed with Docker, you need to do the following:

Rebuild the images and start the test containers:

```bash
CVAT_DEBUG_ENABLED=yes pytest --rebuild --start-services tests/python
```

Now, you can use VS Code tasks to attach to the running server containers.
To attach to a container, run one of the following tasks:
- `REST API tests: Attach to server` for the server container
- `REST API tests: Attach to RQ low` for the low priority queue worker
- `REST API tests: Attach to RQ default` for the default priority queue worker

> If you have a custom development environment setup, you need to adjust
host-remote path mappings in the `.vscode/launch.json`:
```json
...
"pathMappings": [
   {
      "localRoot": "${workspaceFolder}/my_venv",
      "remoteRoot": "/opt/venv",
   },
   {
      "localRoot": "/some/other/path",
      "remoteRoot": "/some/container/path",
   }
]
```

Extra options:
- If you want the server to wait for a debugger on startup,
  use the `CVAT_DEBUG_WAIT_CLIENT` environment variable:
  ```bash
  CVAT_DEBUG_WAIT_CLIENT=yes pytest ...
  ```
- If you want to change the default debugging ports, check the `*_DEBUG_PORT`
  variables in the `docker-compose.dev.yml`


# Unit tests

**Initial steps**
1. Install necessary Python dependencies:
   ```
   pip install -r cvat/requirements/testing.txt
   ```
1. Install npm dependencies:
   ```
   yarn --frozen-lockfile
   ```
1. Run CVAT instance
   ```
   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
   ```

**Running tests**
1. Python tests
   ```
   python manage.py test --settings cvat.settings.testing cvat/apps
   ```
1. JS tests
   ```
   cd cvat-core
   yarn run test
   ```


<a id="opa-tests"></a>
## IAM and Open Policy Agent tests

### Generate tests

```bash
python cvat/apps/iam/rules/tests/generate_tests.py \
   --output-dir cvat/apps/iam/rules/
```

### Run testing

- In a Docker container
```bash
docker run --rm -v ${PWD}/cvat/apps/iam/rules:/rules \
   openpolicyagent/opa:0.45.0-rootless \
   test /rules -v
```

- or execute OPA directly
```bash
curl -L -o opa https://openpolicyagent.org/downloads/v0.45.0/opa_linux_amd64_static
chmod +x ./opa
./opa test cvat/apps/iam/rules
```
