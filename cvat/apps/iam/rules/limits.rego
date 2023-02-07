package limits

import future.keywords.if
import future.keywords.in
import future.keywords.contains

import data.utils


CAP_USER_SANDBOX_TASKS = "USER_SANDBOX_TASKS"
CAP_USER_SANDBOX_PROJECTS = "USER_SANDBOX_PROJECTS"
CAP_TASKS_IN_USER_SANDBOX_PROJECT = "TASKS_IN_USER_SANDBOX_PROJECT"
CAP_USER_OWNED_ORGS = "USER_OWNED_ORGS"
CAP_USER_SANDBOX_CLOUD_STORAGES = "USER_SANDBOX_CLOUD_STORAGES"
CAP_ORG_TASKS = "ORG_TASKS"
CAP_ORG_PROJECTS = "ORG_PROJECTS"
CAP_TASKS_IN_ORG_PROJECT = "TASKS_IN_ORG_PROJECT"
CAP_ORG_CLOUD_STORAGES = "ORG_CLOUD_STORAGES"
CAP_ORG_COMMON_WEBHOOKS = "ORG_COMMON_WEBHOOKS"
CAP_PROJECT_WEBHOOKS = "PROJECT_WEBHOOKS"


check_limit_exceeded(current, max) {
    null != max
    current >= max
}



problems contains "tasks per user" if {
    check_limit_exceeded(
        input.resource.limits[CAP_USER_SANDBOX_TASKS].used,
        input.resource.limits[CAP_USER_SANDBOX_TASKS].max
    )
}

problems contains "projects per user" if {
    check_limit_exceeded(
        input.resource.limits[CAP_USER_SANDBOX_PROJECTS].used,
        input.resource.limits[CAP_USER_SANDBOX_PROJECTS].max
    )
}

problems contains "tasks per project for the user" if {
    check_limit_exceeded(
        input.resource.limits[CAP_TASKS_IN_USER_SANDBOX_PROJECT].used,
        input.resource.limits[CAP_TASKS_IN_USER_SANDBOX_PROJECT].max
    )
}

problems contains "tasks per organization" if {
    check_limit_exceeded(
        input.resource.limits[CAP_ORG_TASKS].used,
        input.resource.limits[CAP_ORG_TASKS].max
    )
}

problems contains "projects per organization" if {
    check_limit_exceeded(
        input.resource.limits[CAP_ORG_PROJECTS].used,
        input.resource.limits[CAP_ORG_PROJECTS].max
    )
}

problems contains "tasks per project for the organization" if {
    check_limit_exceeded(
        input.resource.limits[CAP_TASKS_IN_ORG_PROJECT].used,
        input.resource.limits[CAP_TASKS_IN_ORG_PROJECT].max
    )
}

problems contains "webhooks per project" if {
    check_limit_exceeded(
        input.resource.limits[CAP_PROJECT_WEBHOOKS].used,
        input.resource.limits[CAP_PROJECT_WEBHOOKS].max
    )
}

problems contains "webhooks per organization" if {
    check_limit_exceeded(
        input.resource.limits[CAP_ORG_COMMON_WEBHOOKS].used,
        input.resource.limits[CAP_ORG_COMMON_WEBHOOKS].max
    )
}

problems contains "organizations per user" if {
    check_limit_exceeded(
        input.resource.limits[CAP_USER_OWNED_ORGS].used,
        input.resource.limits[CAP_USER_OWNED_ORGS].max
    )
}

problems contains "cloud storages per user" if {
    check_limit_exceeded(
        input.resource.limits[CAP_USER_SANDBOX_CLOUD_STORAGES].used,
        input.resource.limits[CAP_USER_SANDBOX_CLOUD_STORAGES].max
    )
}

problems contains "cloud storages per organization" if {
    check_limit_exceeded(
        input.resource.limits[CAP_ORG_CLOUD_STORAGES].used,
        input.resource.limits[CAP_ORG_CLOUD_STORAGES].max
    )
}

# In the case of invalid input or no applicable limits,
# we deny the request. We suppose that we always check at least 1
# limit, and this package is queried by IAM only when there are
# limits to check in the input scope.
default result = {
    "allow": false,
    "reasons": []
}

result := {
    "allow": true,
    "reasons": [],
} if {
    utils.is_admin
} else := {
    "allow": count(problems) == 0,
    "reasons": problems
} if {
    not utils.is_admin
    count(input.resource.limits) != 0
}

allow := result.allow
