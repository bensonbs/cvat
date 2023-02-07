---
title: 'Frequently asked questions'
linkTitle: 'FAQ'
weight: 3
description: 'Answers to frequently asked questions'
---

<!--lint disable heading-style-->

## How to migrate data from CVAT.org to CVAT.ai

Please follow the [export tasks and projects guide](/docs/manual/advanced/backup/#backup) to
download an archive with data which corresponds to your task or project. The backup for a
project will have all tasks which are inside the project. Thus you don't need to export
them separately.

Please follow the [import tasks and projects guide](/docs/manual/advanced/backup/#create-from-backup)
to upload your backup with a task or project to a CVAT instance.

See a quick demo below. It is really a simple process. If your data is huge, it may take some time.
Please be patient.

![Export and import backup demo](
  https://user-images.githubusercontent.com/40690625/180879954-44afcd95-1e94-451a-9a60-2f3bd6482cbf.gif)


## How to upgrade CVAT

Before upgrading, please follow the [backup guide](/docs/administration/advanced/backup_guide/)
and backup all CVAT volumes.

Follow the [upgrade guide](/docs/administration/advanced/upgrade_guide/).

## Kibana app works, but no logs are displayed

Make sure there aren't error messages from Elasticsearch:

```bash
docker logs cvat_elasticsearch
```

If you see errors like this:

```bash
lood stage disk watermark [95%] exceeded on [uMg9WI30QIOJxxJNDiIPgQ][uMg9WI3][/usr/share/elasticsearch/data/nodes/0] free: 116.5gb[4%], all indices on this node will be marked read-only
```

You should free up disk space or change the threshold, to do so check: [Elasticsearch documentation](https://www.elastic.co/guide/en/elasticsearch/reference/6.8/disk-allocator.html).

## How to change default CVAT hostname or port

To change the hostname, simply set the `CVAT_HOST` environemnt variable

```bash
export CVAT_HOST=<YOUR_HOSTNAME_OR_IP>
```
NOTE, if you're using `docker compose` with `sudo` to run CVAT, then please add the `-E` (or `--preserve-env`)
flag to preserve the user environment variable which set above to take effect in your docker containers:

```bash
sudo -E docker compose up -d
```

If you want to change the default web application port, change the `ports` part of `traefik` service configuration
in `docker-compose.yml`

```yml
services:
  traefik:
    ...
    ...
    ports:
      - <YOUR_WEB_PORTAL_PORT>:8080
      - 8090:8090
```

Note that changing the port does not make sense if you are using HTTPS - port 443 is conventionally
used for HTTPS connections, and is needed for Let's Encrypt [TLS challenge](https://doc.traefik.io/traefik/https/acme/#tlschallenge).

## How to configure connected share folder on Windows

Follow the Docker manual and configure the directory that you want to use as a shared directory:

- [Docker toolbox manual](https://docs.docker.com/toolbox/toolbox_install_windows/#optional-add-shared-directories)
- [Docker for windows (see FILE SHARING section)](https://docs.docker.com/docker-for-windows/#resources)

After that, it should be possible to use this directory as a CVAT share:

```yaml
services:
  cvat:
    volumes:
      - cvat_share:/home/django/share:ro

volumes:
  cvat_share:
    driver_opts:
      type: none
      device: /d/my_cvat_share
      o: bind
```

## How to make unassigned tasks not visible to all users

Set [reduce_task_visibility](https://github.com/cvat-ai/cvat/blob/develop/cvat/settings/base.py#L455)
variable to `True`.

## Where are uploaded images/videos stored

The uploaded data is stored in the `cvat_data` docker volume:

```yml
volumes:
  - cvat_data:/home/django/data
```

## Where are annotations stored

Annotations are stored in the PostgreSQL database. The database files are stored in the `cvat_db` docker volume:

```yml
volumes:
  - cvat_db:/var/lib/postgresql/data
```

## How to mark job/task as completed

The status is set by the user in the [Info window](/docs/manual/basics/top-panel/#info)
of the job annotation view.
There are three types of status: annotation, validation or completed.
The status of the job changes the progress bar of the task.

## How to install CVAT on Windows 10 Home

Follow this [guide](/docs/administration/basics/installation/#windows-10).

## I do not have the Analytics tab on the header section. How can I add analytics

You should build CVAT images with ['Analytics' component](https://github.com/cvat-ai/cvat/tree/develop/components/analytics).

## How to upload annotations to an entire task from UI when there are multiple jobs in the task

You can upload annotation for a multi-job task from the Dasboard view or the Task view.
Uploading of annotation from the Annotation view only affects the current job.

## How to specify multiple hostnames

To do this, you will need to edit `traefik.http.<router>.cvat.rule` docker label for both the
`cvat` and `cvat_ui` services, like so
(see [the documentation](https://doc.traefik.io/traefik/routing/routers/#rule) on Traefik rules for more details):

```yaml
  cvat:
    labels:
      - traefik.http.routers.cvat.rule=(Host(`example1.com`) || Host(`example2.com`)) &&
          PathPrefix(`/api/`, `/git/`, `/opencv/`, `/analytics/`, `/static/`, `/admin`, `/documentation/`, `/django-rq`)

  cvat_ui:
    labels:
      - traefik.http.routers.cvat-ui.rule=Host(`example1.com`) || Host(`example2.com`)
```

## How to create a task with multiple jobs

Set the segment size when you create a new task, this option is available in the
[Advanced configuration](/docs/manual/basics/creating_an_annotation_task/#advanced-configuration)
section.

## How to transfer CVAT to another machine

Follow the [backup/restore guide](/docs/administration/advanced/backup_guide/#how-to-backup-all-cvat-data).

## How to load your own DL model into CVAT

See the information here in the [Serverless tutorial](/docs/manual/advanced/serverless-tutorial/#adding-your-own-dl-models).

## My server uses a custom SSL certificate and I don't want to check it.

You can call control SSL certificate check with the `--insecure` CLI argument.
For SDK, you can specify `ssl_verify = True/False` in the `cvat_sdk.core.client.Config` object.

