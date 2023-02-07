---
title: 'Upgrade guide'
linkTitle: 'Upgrade guide'
weight: 60
description: 'Instructions for upgrading CVAT deployed with docker compose'
---

<!--lint disable heading-style-->

## Upgrade guide

Note: updating CVAT from version 2.2.0 to version 2.3.0 requires additional manual actions with database data due to
upgrading PostgreSQL base image major version. See details [here](#how-to-upgrade-postgresql-database-base-image)

To upgrade CVAT, follow these steps:

- It is highly recommended backup all CVAT data before updating, follow the
  [backup guide](/docs/administration/advanced/backup_guide/) and backup all CVAT volumes.

- Go to the previously cloned CVAT directory and stop all CVAT containers with:
  ```shell
  docker compose down
  ```
  If you have included [additional components](/docs/administration/basics/installation/#additional-components),
  include all compose configuration files that are used, e.g.:
  ```shell
  docker compose -f docker-compose.yml -f components/analytics/docker-compose.analytics.yml down
  ```

- Update CVAT source code by any preferable way: clone with git or download zip file from GitHub.
  Note that you need to download the entire source code, not just the Docker Compose configuration file.
  Check the
  [installation guide](/docs/administration/basics/installation/#how-to-get-cvat-source-code) for details.

- Verify settings:
  The installation process is changed/modified from version to version and
  you may need to export some environment variables, for example
  [CVAT_HOST](/docs/administration/basics/installation/#use-your-own-domain).

- Update local CVAT images.
  Pull or build new CVAT images, see
  [How to pull/build/update CVAT images section](/docs/administration/basics/installation/#how-to-pullbuildupdate-cvat-images)
  for details.

- Start CVAT with:
  ```shell
  docker compose up -d
  ```
  When CVAT starts, it will upgrade its DB in accordance with the latest schema.
  It can take time especially if you have a lot of data.
  Please do not terminate the migration and wait till the process is complete.
  You can monitor the startup process with the following command:
  ```shell
  docker logs cvat_server -f
  ```
  
## How to upgrade CVAT from v2.2.0 to v2.3.0.

Step by step commands how to upgrade CVAT from v2.2.0 to v2.3.0.
Let's assume that you have CVAT v2.2.0 working.
```shell
docker exec -it cvat_db pg_dumpall > cvat.db.dump
cd cvat
docker compose down
docker volume rm cvat_cvat_db
export CVAT_VERSION="2.3.0"
cd ..
mv cvat cvat_220
wget https://github.com/opencv/cvat/archive/refs/tags/v${CVAT_VERSION}.zip
unzip v${CVAT_VERSION}.zip && mv cvat_${CVAT_VERSION} cvat
cd cvat
export CVAT_HOST=cvat.example.com
export ACME_EMAIL=example@example.com
docker compose pull
docker compose up -d cvat_db
docker exec -i cvat_db psql -q -d postgres < ../cvat.db.dump
docker compose -f docker compose.yml -f docker compose.dev.yml -f docker compose.https.yml up -d
```  
  
## How to upgrade CVAT from v1.7.0 to v2.2.0.

Step by step commands how to upgrade CVAT from v1.7.0 to v2.2.0.
Let's assume that you have CVAT v1.7.0 working.
```shell
export CVAT_VERSION="2.2.0"
cd cvat
docker compose down
cd ..
mv cvat cvat_170
wget https://github.com/opencv/cvat/archive/refs/tags/v${CVAT_VERSION}.zip
unzip v${CVAT_VERSION}.zip && mv cvat_${CVAT_VERSION} cvat
cd cvat
docker pull cvat/server:v${CVAT_VERSION}
docker tag cvat/server:v${CVAT_VERSION} openvino/cvat_server:latest
docker pull cvat/ui:v${CVAT_VERSION}
docker tag cvat/ui:v${CVAT_VERSION} openvino/cvat_ui:latest
docker compose up -d
```
  
## How to upgrade PostgreSQL database base image

1. It is highly recommended backup all CVAT data before updating, follow the
   [backup guide](/docs/administration/advanced/backup_guide/) and backup CVAT database volume.

1. Run previosly used CVAT version as usual

1. Backup current database with `pg_dumpall` tool:
   ```shell
   docker exec -it cvat_db pg_dumpall > cvat.db.dump
   ```

1. Stop CVAT:
   ```shell
   docker compose down
   ```

1. Delete current PostrgeSQL’s volume, that's why it's important to have a backup:
   ```shell
   docker volume rm cvat_cvat_db
   ```

1. Update CVAT source code by any preferable way: clone with git or download zip file from GitHub.
   Check the
   [installation guide](/docs/administration/basics/installation/#how-to-get-cvat-source-code) for details.

1. Start database container only:
   ```shell
   docker compose up -d cvat_db
   ```

1. Import PostgreSQL dump into new DB container:
   ```shell
   docker exec -i cvat_db psql -q -d postgres < cvat.db.dump
   ```

1. Start CVAT:
   ```shell
   docker compose up -d
   ```
