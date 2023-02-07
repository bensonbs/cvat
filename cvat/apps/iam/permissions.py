# Copyright (C) 2022 Intel Corporation
# Copyright (C) 2022 CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

from __future__ import annotations
from abc import ABCMeta, abstractmethod
from collections import namedtuple
from enum import Enum, auto
import operator
from typing import Any, List, Optional, Sequence, Tuple, cast

from attrs import define, field
from rest_framework.exceptions import ValidationError, PermissionDenied

import requests
from django.conf import settings
from django.db.models import Q
from rest_framework.permissions import BasePermission

from cvat.apps.organizations.models import Membership, Organization
from cvat.apps.engine.models import Project, Task, Job, Issue
from cvat.apps.iam.exceptions import LimitsReachedException
from cvat.apps.limit_manager.core.limits import (CapabilityContext, LimitManager,
    Limits, OrgCloudStoragesContext, OrgTasksContext, ProjectWebhooksContext,
    OrgCommonWebhooksContext,
    TasksInOrgProjectContext, TasksInUserSandboxProjectContext, UserOrgsContext,
    UserSandboxCloudStoragesContext, UserSandboxTasksContext)
from cvat.apps.webhooks.models import WebhookTypeChoice


class StrEnum(str, Enum):
    def __str__(self) -> str:
        return self.value


@define
class PermissionResult:
    allow: bool
    reasons: List[str] = field(factory=list)

class OpenPolicyAgentPermission(metaclass=ABCMeta):
    url: str
    user_id: int
    group_name: Optional[str]
    org_id: Optional[int]
    org_owner_id: Optional[int]
    org_role: Optional[str]
    scope: str
    obj: Optional[Any]

    @classmethod
    @abstractmethod
    def create(cls, request, view, obj) -> Sequence[OpenPolicyAgentPermission]:
        ...

    @classmethod
    def create_base_perm(cls, request, view, scope, obj=None, **kwargs):
        return cls(
            scope=scope,
            obj=obj,
            **cls.unpack_context(request), **kwargs)

    @classmethod
    def create_scope_list(cls, request):
        return cls(**cls.unpack_context(request), scope='list')

    @staticmethod
    def unpack_context(request):
        privilege = request.iam_context['privilege']
        organization = request.iam_context['organization']
        membership = request.iam_context['membership']

        return {
            'user_id': request.user.id,
            'group_name': getattr(privilege, 'name', None),
            'org_id': getattr(organization, 'id', None),
            'org_owner_id': getattr(organization.owner, 'id', None)
                if organization else None,
            'org_role': getattr(membership, 'role', None),
        }

    def __init__(self, **kwargs):
        self.obj = None
        for name, val in kwargs.items():
            setattr(self, name, val)

        self.payload = {
            'input': {
                'scope': self.scope,
                'auth': {
                    'user': {
                        'id': self.user_id,
                        'privilege': self.group_name
                    },
                    'organization': {
                        'id': self.org_id,
                        'owner': {
                            'id': self.org_owner_id,
                        },
                        'user': {
                            'role': self.org_role,
                        },
                    } if self.org_id is not None else None
                }
            }
        }

        self.payload['input']['resource'] = self.get_resource()

    @abstractmethod
    def get_resource(self):
        return None

    def check_access(self) -> PermissionResult:
        response = requests.post(self.url, json=self.payload)
        output = response.json()['result']

        allow = False
        reasons = []
        if isinstance(output, dict):
            allow = output['allow']
            reasons = output.get('reasons', [])
        elif isinstance(output, bool):
            allow = output
        else:
            raise ValueError("Unexpected response format")

        return PermissionResult(allow=allow, reasons=reasons)

    def filter(self, queryset):
        url = self.url.replace('/allow', '/filter')
        r = requests.post(url, json=self.payload)
        q_objects = []
        ops_dict = {
            '|': operator.or_,
            '&': operator.and_,
            '~': operator.not_,
        }
        for item in r.json()['result']:
            if isinstance(item, str):
                val1 = q_objects.pop()
                if item == '~':
                    q_objects.append(ops_dict[item](val1))
                else:
                    val2 = q_objects.pop()
                    q_objects.append(ops_dict[item](val1, val2))
            else:
                q_objects.append(Q(**item))

        if q_objects:
            assert len(q_objects) == 1
        else:
            q_objects.append(Q())

        # By default, a QuerySet will not eliminate duplicate rows. If your
        # query spans multiple tables (e.g. members__user_id, owner_id), it’s
        # possible to get duplicate results when a QuerySet is evaluated.
        # That’s when you’d use distinct().
        return queryset.filter(q_objects[0]).distinct()

class OrganizationPermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        LIST = 'list'
        CREATE = 'create'
        DELETE = 'delete'
        UPDATE = 'update'
        VIEW = 'view'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'organization':
            for scope in cls.get_scopes(request, view, obj):
                self = cls.create_base_perm(request, view, scope, obj)
                permissions.append(self)

        return permissions

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + '/organizations/allow'

    @staticmethod
    def get_scopes(request, view, obj):
        Scopes = __class__.Scopes
        return [{
            'list': Scopes.LIST,
            'create': Scopes.CREATE,
            'destroy': Scopes.DELETE,
            'partial_update': Scopes.UPDATE,
            'retrieve': Scopes.VIEW,
        }.get(view.action, None)]

    def get_resource(self):
        if self.obj:
            membership = Membership.objects.filter(
                organization=self.obj, user=self.user_id).first()
            return {
                'id': self.obj.id,
                'owner': {
                    'id': getattr(self.obj.owner, 'id', None)
                },
                'user': {
                    'role': membership.role if membership else None
                }
            }
        elif self.scope.startswith(__class__.Scopes.CREATE.value):
            return {
                'id': None,
                'owner': {
                    'id': self.user_id
                },
                'user': {
                    'role': 'owner'
                }
            }
        else:
            return None

class InvitationPermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        LIST = 'list'
        CREATE = 'create'
        DELETE = 'delete'
        ACCEPT = 'accept'
        RESEND = 'resend'
        VIEW = 'view'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'invitation':
            for scope in cls.get_scopes(request, view, obj):
                self = cls.create_base_perm(request, view, scope, obj,
                    role=request.data.get('role'))
                permissions.append(self)

        return permissions

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.role = kwargs.get('role')
        self.url = settings.IAM_OPA_DATA_URL + '/invitations/allow'

    @staticmethod
    def get_scopes(request, view, obj):
        Scopes = __class__.Scopes
        return [{
            'list': Scopes.LIST,
            'create': Scopes.CREATE,
            'destroy': Scopes.DELETE,
            'partial_update': Scopes.ACCEPT if 'accepted' in
                request.query_params else Scopes.RESEND,
            'retrieve': Scopes.VIEW,
        }.get(view.action)]

    def get_resource(self):
        data = None
        if self.obj:
            data = {
                'owner': { 'id': getattr(self.obj.owner, 'id', None) },
                'invitee': { 'id': getattr(self.obj.membership.user, 'id', None) },
                'role': self.obj.membership.role,
                'organization': {
                    'id': self.obj.membership.organization.id
                }
            }
        elif self.scope.startswith(__class__.Scopes.CREATE.value):
            data = {
                'owner': { 'id': self.user_id },
                'invitee': {
                    'id': None # unknown yet
                },
                'role': self.role,
                'organization': {
                    'id': self.org_id
                } if self.org_id is not None else None
            }

        return data

class MembershipPermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        LIST = 'list'
        UPDATE = 'change'
        UPDATE_ROLE = 'change:role'
        VIEW = 'view'
        DELETE = 'delete'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'membership':
            for scope in cls.get_scopes(request, view, obj):
                params = {}
                if scope == 'change:role':
                    params['role'] = request.data.get('role')

                self = cls.create_base_perm(request, view, scope, obj, **params)
                permissions.append(self)

        return permissions

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + '/memberships/allow'

    @staticmethod
    def get_scopes(request, view, obj):
        Scopes = __class__.Scopes
        scopes = []

        scope = {
            'list': Scopes.LIST,
            'partial_update': Scopes.UPDATE,
            'retrieve': Scopes.VIEW,
            'destroy': Scopes.DELETE,
        }.get(view.action)

        if scope == Scopes.UPDATE:
            if request.data.get('role') != cast(Membership, obj).role:
                scopes.append(Scopes.UPDATE_ROLE)
        elif scope:
            scopes.append(scope)

        return scopes

    def get_resource(self):
        if self.obj:
            return {
                'role': self.obj.role,
                'is_active': self.obj.is_active,
                'user': { 'id': self.obj.user.id },
                'organization': { 'id': self.obj.organization.id }
            }
        else:
            return None

class ServerPermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        VIEW = 'view'
        SEND_EXCEPTION = 'send:exception'
        SEND_LOGS = 'send:logs'
        LIST_CONTENT = 'list:content'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'server':
            for scope in cls.get_scopes(request, view, obj):
                self = cls.create_base_perm(request, view, scope, obj)
                permissions.append(self)

        return permissions

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + '/server/allow'

    @staticmethod
    def get_scopes(request, view, obj):
        Scopes = __class__.Scopes
        return [{
            'annotation_formats': Scopes.VIEW,
            'about': Scopes.VIEW,
            'plugins': Scopes.VIEW,
            'exception': Scopes.SEND_EXCEPTION,
            'logs': Scopes.SEND_LOGS,
            'share': Scopes.LIST_CONTENT,
        }.get(view.action, None)]

    def get_resource(self):
        return None

class LogViewerPermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        VIEW = 'view'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'analytics':
            for scope in cls.get_scopes(request, view, obj):
                self = cls.create_base_perm(request, view, scope, obj)
                permissions.append(self)

        return permissions

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + '/analytics/allow'

    @staticmethod
    def get_scopes(request, view, obj):
        Scopes = __class__.Scopes
        return [{
            'list': Scopes.VIEW,
        }.get(view.action, None)]

    def get_resource(self):
        return {
            'visibility': 'public' if settings.RESTRICTIONS['analytics_visibility'] else 'private',
        }

class UserPermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        LIST = 'list'
        VIEW = 'view'
        UPDATE = 'update'
        DELETE = 'delete'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'user':
            for scope in cls.get_scopes(request, view, obj):
                self = cls.create_base_perm(request, view, scope, obj)
                permissions.append(self)

        return permissions

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + '/users/allow'

    @staticmethod
    def get_scopes(request, view, obj):
        Scopes = __class__.Scopes
        return [{
            'list': Scopes.LIST,
            'self': Scopes.VIEW,
            'retrieve': Scopes.VIEW,
            'partial_update': Scopes.UPDATE,
            'destroy': Scopes.DELETE,
        }.get(view.action)]

    @classmethod
    def create_scope_view(cls, request, user_id):
        obj = namedtuple('User', ['id'])(id=int(user_id))
        return cls(**cls.unpack_context(request), scope=__class__.Scopes.VIEW, obj=obj)

    def get_resource(self):
        data = None
        organization = self.payload['input']['auth']['organization']
        if self.obj:
            data = {
                'id': self.obj.id
            }
        elif self.scope == __class__.Scopes.VIEW: # self
            data = {
                'id': self.user_id
            }

        if data:
            data.update({
                'membership': {
                    'role': organization['user']['role']
                        if organization else None
                }
            })

        return data

class LambdaPermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        LIST = 'list'
        VIEW = 'view'
        CALL_ONLINE = 'call:online'
        CALL_OFFLINE = 'call:offline'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'function' or view.basename == 'request':
            scopes = cls.get_scopes(request, view, obj)
            for scope in scopes:
                self = cls.create_base_perm(request, view, scope, obj)
                permissions.append(self)

            if job_id := request.data.get('job'):
                perm = JobPermission.create_scope_view_data(request, job_id)
                permissions.append(perm)
            elif task_id := request.data.get('task'):
                perm = TaskPermission.create_scope_view_data(request, task_id)
                permissions.append(perm)

        return permissions

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + '/lambda/allow'

    @staticmethod
    def get_scopes(request, view, obj):
        Scopes = __class__.Scopes
        return [{
            ('function', 'list'): Scopes.LIST,
            ('function', 'retrieve'): Scopes.VIEW,
            ('function', 'call'): Scopes.CALL_ONLINE,
            ('request', 'create'): Scopes.CALL_OFFLINE,
            ('request', 'list'): Scopes.CALL_OFFLINE,
            ('request', 'retrieve'): Scopes.CALL_OFFLINE,
            ('request', 'destroy'): Scopes.CALL_OFFLINE,
        }.get((view.basename, view.action), None)]

    def get_resource(self):
        return None

class CloudStoragePermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        LIST = 'list'
        LIST_CONTENT = 'list:content'
        CREATE = 'create'
        VIEW = 'view'
        UPDATE = 'update'
        DELETE = 'delete'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'cloudstorage':
            for scope in cls.get_scopes(request, view, obj):
                self = cls.create_base_perm(request, view, scope, obj)
                permissions.append(self)

        return permissions

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + '/cloudstorages/allow'

    @staticmethod
    def get_scopes(request, view, obj):
        Scopes = __class__.Scopes
        return [{
            'list': Scopes.LIST,
            'create': Scopes.CREATE,
            'retrieve': Scopes.VIEW,
            'partial_update': Scopes.UPDATE,
            'destroy': Scopes.DELETE,
            'content': Scopes.LIST_CONTENT,
            'preview': Scopes.VIEW,
            'status': Scopes.VIEW,
            'actions': Scopes.VIEW,
        }.get(view.action)]

    def get_resource(self):
        data = None
        if self.scope.startswith('create'):
            data = {
                'owner': { 'id': self.user_id },
                'organization': {
                    'id': self.org_id,
                } if self.org_id is not None else None,
            }
        elif self.obj:
            data = {
                'id': self.obj.id,
                'owner': { 'id': getattr(self.obj.owner, 'id', None) },
                'organization': {
                    'id': self.obj.organization.id
                } if self.obj.organization else None
            }

        return data

class ProjectPermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        LIST = 'list'
        CREATE = 'create'
        DELETE = 'delete'
        UPDATE = 'update'
        UPDATE_OWNER = 'update:owner'
        UPDATE_ASSIGNEE = 'update:assignee'
        UPDATE_DESC = 'update:desc'
        UPDATE_ORG = 'update:organization'
        VIEW = 'view'
        IMPORT_DATASET = 'import:dataset'
        EXPORT_ANNOTATIONS = 'export:annotations'
        EXPORT_DATASET = 'export:dataset'
        EXPORT_BACKUP = 'export:backup'
        IMPORT_BACKUP = 'import:backup'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'project':
            assignee_id = request.data.get('assignee_id') or request.data.get('assignee')
            for scope in cls.get_scopes(request, view, obj):
                self = cls.create_base_perm(request, view, scope, obj,
                    assignee_id=assignee_id)
                permissions.append(self)

            if view.action == 'tasks':
                perm = TaskPermission.create_scope_list(request)
                permissions.append(perm)

            owner = request.data.get('owner_id') or request.data.get('owner')
            if owner:
                perm = UserPermission.create_scope_view(request, owner)
                permissions.append(perm)

            if assignee_id:
                perm = UserPermission.create_scope_view(request, assignee_id)
                permissions.append(perm)

        return permissions

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + '/projects/allow'

    @staticmethod
    def get_scopes(request, view, obj):
        Scopes = __class__.Scopes
        scope = {
            ('list', 'GET'): Scopes.LIST,
            ('create', 'POST'): Scopes.CREATE,
            ('destroy', 'DELETE'): Scopes.DELETE,
            ('partial_update', 'PATCH'): Scopes.UPDATE,
            ('retrieve', 'GET'): Scopes.VIEW,
            ('tasks', 'GET'): Scopes.VIEW,
            ('dataset', 'POST'): Scopes.IMPORT_DATASET,
            ('append_dataset_chunk', 'HEAD'): Scopes.IMPORT_DATASET,
            ('append_dataset_chunk', 'PATCH'): Scopes.IMPORT_DATASET,
            ('annotations', 'GET'): Scopes.EXPORT_ANNOTATIONS,
            ('dataset', 'GET'): Scopes.EXPORT_DATASET,
            ('export_backup', 'GET'): Scopes.EXPORT_BACKUP,
            ('import_backup', 'POST'): Scopes.IMPORT_BACKUP,
            ('append_backup_chunk', 'PATCH'): Scopes.IMPORT_BACKUP,
            ('append_backup_chunk', 'HEAD'): Scopes.IMPORT_BACKUP,
            ('preview', 'GET'): Scopes.VIEW,
        }.get((view.action, request.method))

        scopes = []
        if scope == Scopes.UPDATE:
            if any(k in request.data for k in ('owner_id', 'owner')):
                owner_id = request.data.get('owner_id') or request.data.get('owner')
                if owner_id != getattr(obj.owner, 'id', None):
                    scopes.append(Scopes.UPDATE_OWNER)
            if any(k in request.data for k in ('assignee_id', 'assignee')):
                assignee_id = request.data.get('assignee_id') or request.data.get('assignee')
                if assignee_id != getattr(obj.assignee, 'id', None):
                    scopes.append(Scopes.UPDATE_ASSIGNEE)
            for field in ('name', 'labels', 'bug_tracker'):
                if field in request.data:
                    scopes.append(Scopes.UPDATE_DESC)
                    break
            if 'organization' in request.data:
                scopes.append(Scopes.UPDATE_ORG)
        else:
            scopes.append(scope)

        return scopes

    @classmethod
    def create_scope_view(cls, request, project_id):
        try:
            obj = Project.objects.get(id=project_id)
        except Project.DoesNotExist as ex:
            raise ValidationError(str(ex))
        return cls(**cls.unpack_context(request), obj=obj, scope=__class__.Scopes.VIEW)

    @classmethod
    def create_scope_create(cls, request, org_id):
        organization = None
        membership = None
        privilege = request.iam_context['privilege']
        if org_id:
            try:
                organization = Organization.objects.get(id=org_id)
            except Organization.DoesNotExist as ex:
                raise ValidationError(str(ex))

            try:
                membership = Membership.objects.filter(
                    organization=organization, user=request.user).first()
            except Membership.DoesNotExist:
                membership = None

        return cls(
            user_id=request.user.id,
            group_name=getattr(privilege, 'name', None),
            org_id=getattr(organization, 'id', None),
            org_owner_id=getattr(organization.owner, 'id', None)
                if organization else None,
            org_role=getattr(membership, 'role', None),
            scope=__class__.Scopes.CREATE)

    def get_resource(self):
        data = None
        if self.obj:
            data = {
                "id": self.obj.id,
                "owner": { "id": getattr(self.obj.owner, 'id', None) },
                "assignee": { "id": getattr(self.obj.assignee, 'id', None) },
                'organization': {
                    "id": getattr(self.obj.organization, 'id', None)
                }
            }
        elif self.scope in [__class__.Scopes.CREATE, __class__.Scopes.IMPORT_BACKUP]:
            data = {
                "id": None,
                "owner": { "id": self.user_id },
                "assignee": {
                    "id": self.assignee_id,
                } if getattr(self, 'assignee_id', None) else None,
                'organization': {
                    "id": self.org_id,
                } if self.org_id else None,
            }

        return data

class TaskPermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        LIST = 'list'
        CREATE = 'create'
        CREATE_IN_PROJECT = 'create@project'
        VIEW = 'view'
        UPDATE = 'update'
        UPDATE_DESC = 'update:desc'
        UPDATE_ORGANIZATION = 'update:organization'
        UPDATE_ASSIGNEE = 'update:assignee'
        UPDATE_PROJECT = 'update:project'
        UPDATE_OWNER = 'update:owner'
        DELETE = 'delete'
        VIEW_ANNOTATIONS = 'view:annotations'
        UPDATE_ANNOTATIONS = 'update:annotations'
        DELETE_ANNOTATIONS = 'delete:annotations'
        IMPORT_ANNOTATIONS = 'import:annotations'
        EXPORT_ANNOTATIONS = 'export:annotations'
        EXPORT_DATASET = 'export:dataset'
        VIEW_METADATA = 'view:metadata'
        UPDATE_METADATA = 'update:metadata'
        VIEW_DATA = 'view:data'
        UPLOAD_DATA = 'upload:data'
        IMPORT_BACKUP = 'import:backup'
        EXPORT_BACKUP = 'export:backup'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'task':
            project_id = request.data.get('project_id') or request.data.get('project')
            assignee_id = request.data.get('assignee_id') or request.data.get('assignee')
            owner = request.data.get('owner_id') or request.data.get('owner')
            for scope in cls.get_scopes(request, view, obj):
                params = { 'project_id': project_id, 'assignee_id': assignee_id }

                if scope == __class__.Scopes.UPDATE_ORGANIZATION:
                    org_id = request.data.get('organization')
                    if obj is not None and obj.project is not None:
                        raise ValidationError('Cannot change the organization for '
                            'a task inside a project')
                    permissions.append(TaskPermission.create_scope_create(request, org_id))
                elif scope == __class__.Scopes.UPDATE_OWNER:
                    params['owner_id'] = owner

                self = cls.create_base_perm(request, view, scope, obj, **params)
                permissions.append(self)

            if view.action == 'jobs':
                perm = JobPermission.create_scope_list(request)
                permissions.append(perm)

            if owner:
                perm = UserPermission.create_scope_view(request, owner)
                permissions.append(perm)

            if assignee_id:
                perm = UserPermission.create_scope_view(request, assignee_id)
                permissions.append(perm)

            if project_id:
                perm = ProjectPermission.create_scope_view(request, project_id)
                permissions.append(perm)

        return permissions

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + '/tasks/allow'

    @staticmethod
    def get_scopes(request, view, obj) -> Scopes:
        Scopes = __class__.Scopes
        scope = {
            ('list', 'GET'): Scopes.LIST,
            ('create', 'POST'): Scopes.CREATE,
            ('retrieve', 'GET'): Scopes.VIEW,
            ('status', 'GET'): Scopes.VIEW,
            ('partial_update', 'PATCH'): Scopes.UPDATE,
            ('update', 'PUT'): Scopes.UPDATE,
            ('destroy', 'DELETE'): Scopes.DELETE,
            ('annotations', 'GET'): Scopes.VIEW_ANNOTATIONS,
            ('annotations', 'PATCH'): Scopes.UPDATE_ANNOTATIONS,
            ('annotations', 'DELETE'): Scopes.DELETE_ANNOTATIONS,
            ('annotations', 'PUT'): Scopes.UPDATE_ANNOTATIONS,
            ('annotations', 'POST'): Scopes.IMPORT_ANNOTATIONS,
            ('append_annotations_chunk', 'PATCH'): Scopes.UPDATE_ANNOTATIONS,
            ('append_annotations_chunk', 'HEAD'): Scopes.UPDATE_ANNOTATIONS,
            ('dataset_export', 'GET'): Scopes.EXPORT_DATASET,
            ('metadata', 'GET'): Scopes.VIEW_METADATA,
            ('metadata', 'PATCH'): Scopes.UPDATE_METADATA,
            ('data', 'GET'): Scopes.VIEW_DATA,
            ('data', 'POST'): Scopes.UPLOAD_DATA,
            ('append_data_chunk', 'PATCH'): Scopes.UPLOAD_DATA,
            ('append_data_chunk', 'HEAD'): Scopes.UPLOAD_DATA,
            ('jobs', 'GET'): Scopes.VIEW,
            ('import_backup', 'POST'): Scopes.IMPORT_BACKUP,
            ('append_backup_chunk', 'PATCH'): Scopes.IMPORT_BACKUP,
            ('append_backup_chunk', 'HEAD'): Scopes.IMPORT_BACKUP,
            ('export_backup', 'GET'): Scopes.EXPORT_BACKUP,
            ('preview', 'GET'): Scopes.VIEW,
        }.get((view.action, request.method))

        scopes = []
        if scope == Scopes.CREATE:
            project_id = request.data.get('project_id') or request.data.get('project')
            if project_id:
                scope = Scopes.CREATE_IN_PROJECT

            scopes.append(scope)

        elif scope == Scopes.UPDATE:
            if any(k in request.data for k in ('owner_id', 'owner')):
                owner_id = request.data.get('owner_id') or request.data.get('owner')
                if owner_id != getattr(obj.owner, 'id', None):
                    scopes.append(Scopes.UPDATE_OWNER)

            if any(k in request.data for k in ('assignee_id', 'assignee')):
                assignee_id = request.data.get('assignee_id') or request.data.get('assignee')
                if assignee_id != getattr(obj.assignee, 'id', None):
                    scopes.append(Scopes.UPDATE_ASSIGNEE)

            if any(k in request.data for k in ('project_id', 'project')):
                project_id = request.data.get('project_id') or request.data.get('project')
                if project_id != getattr(obj.project, 'id', None):
                    scopes.append(Scopes.UPDATE_PROJECT)

            if any(k in request.data for k in ('name', 'labels', 'bug_tracker', 'subset')):
                scopes.append(Scopes.UPDATE_DESC)

            if request.data.get('organization'):
                scopes.append(Scopes.UPDATE_ORGANIZATION)

        elif scope == Scopes.VIEW_ANNOTATIONS:
            if 'format' in request.query_params:
                scope = Scopes.EXPORT_ANNOTATIONS

            scopes.append(scope)

        elif scope == Scopes.UPDATE_ANNOTATIONS:
            if 'format' in request.query_params and request.method == 'PUT':
                scope = Scopes.IMPORT_ANNOTATIONS

            scopes.append(scope)

        elif scope is not None:
            scopes.append(scope)

        else:
            # TODO: think if we can protect from missing endpoints
            # assert False, "Unknown scope"
            pass

        return scopes

    @classmethod
    def create_scope_view_data(cls, request, task_id):
        try:
            obj = Task.objects.get(id=task_id)
        except Task.DoesNotExist as ex:
            raise ValidationError(str(ex))
        return cls(**cls.unpack_context(request), obj=obj, scope=__class__.Scopes.VIEW_DATA)

    def get_resource(self):
        data = None
        if self.obj:
            data = {
                "id": self.obj.id,
                "owner": { "id": getattr(self.obj.owner, 'id', None) },
                "assignee": { "id": getattr(self.obj.assignee, 'id', None) },
                'organization': {
                    "id": getattr(self.obj.organization, 'id', None)
                },
                "project": {
                    "owner": { "id": getattr(self.obj.project.owner, 'id', None) },
                    "assignee": { "id": getattr(self.obj.project.assignee, 'id', None) },
                    'organization': {
                        "id": getattr(self.obj.project.organization, 'id', None)
                    },
                } if self.obj.project else None
            }
        elif self.scope in [
            __class__.Scopes.CREATE,
            __class__.Scopes.CREATE_IN_PROJECT,
            __class__.Scopes.IMPORT_BACKUP
        ]:
            project = None
            if self.project_id:
                try:
                    project = Project.objects.get(id=self.project_id)
                except Project.DoesNotExist as ex:
                    raise ValidationError(str(ex))

            data = {
                "id": None,
                "owner": { "id": self.user_id },
                "assignee": {
                    "id": self.assignee_id
                },
                'organization': {
                    "id": self.org_id
                },
                "project": {
                    "owner": { "id": getattr(project.owner, 'id', None) },
                    "assignee": { "id": getattr(project.assignee, 'id', None) },
                    'organization': {
                        "id": getattr(project.organization, 'id', None),
                    } if project.organization is not None else None,
                } if project is not None else None,
            }

        return data


class WebhookPermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        CREATE = 'create'
        CREATE_IN_PROJECT = 'create@project'
        CREATE_IN_ORG = 'create@organization'
        DELETE = 'delete'
        UPDATE = 'update'
        LIST = 'list'
        VIEW = 'view'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'webhook':
            project_id = request.data.get('project_id')
            for scope in cls.get_scopes(request, view, obj):
                self = cls.create_base_perm(request, view, scope, obj,
                    project_id=project_id)
                permissions.append(self)

            owner = request.data.get('owner_id') or request.data.get('owner')
            if owner:
                perm = UserPermission.create_scope_view(request, owner)
                permissions.append(perm)

            if project_id:
                perm = ProjectPermission.create_scope_view(request, project_id)
                permissions.append(perm)

        return permissions

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + '/webhooks/allow'

    @staticmethod
    def get_scopes(request, view, obj):
        Scopes = __class__.Scopes
        scope = {
            ('create', 'POST'): Scopes.CREATE,
            ('destroy', 'DELETE'): Scopes.DELETE,
            ('partial_update', 'PATCH'): Scopes.UPDATE,
            ('update', 'PUT'): Scopes.UPDATE,
            ('list', 'GET'): Scopes.LIST,
            ('retrieve', 'GET'): Scopes.VIEW,
        }.get((view.action, request.method))

        scopes = []
        if scope == Scopes.CREATE:
            webhook_type = request.data.get('type')
            if webhook_type in [m.value for m in WebhookTypeChoice]:
                scope = Scopes(str(scope) + f'@{webhook_type}')
            scopes.append(scope)
        elif scope in [Scopes.UPDATE, Scopes.DELETE, Scopes.LIST, Scopes.VIEW]:
            scopes.append(scope)

        return scopes

    def get_resource(self):
        data = None
        if self.obj:
            data = {
                "id": self.obj.id,
                "owner": {"id": getattr(self.obj.owner, 'id', None) },
                'organization': {
                    "id": getattr(self.obj.organization, 'id', None)
                },
                "project": None
            }
            if self.obj.type == 'project' and getattr(self.obj, 'project', None):
                data['project'] = {
                    'owner': {'id': getattr(self.obj.project.owner, 'id', None)}
                }
        elif self.scope in [
            __class__.Scopes.CREATE,
            __class__.Scopes.CREATE_IN_PROJECT,
            __class__.Scopes.CREATE_IN_ORG
        ]:
            project = None
            if self.project_id:
                try:
                    project = Project.objects.get(id=self.project_id)
                except Project.DoesNotExist:
                    raise ValidationError(f"Could not find project with provided id: {self.project_id}")

            data = {
                'id': None,
                'owner': self.user_id,
                'project': {
                    'owner': {
                        'id': project.owner.id,
                    } if project.owner else None,
                } if project else None,
                'organization': {
                    'id': self.org_id,
                } if self.org_id is not None else None,
                'user': {
                    'id': self.user_id,
                }
            }

        return data

class JobPermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        LIST = 'list'
        VIEW = 'view'
        UPDATE = 'update'
        UPDATE_ASSIGNEE = 'update:assignee'
        UPDATE_OWNER = 'update:owner'
        UPDATE_PROJECT = 'update:project'
        UPDATE_STAGE = 'update:stage'
        UPDATE_STATE = 'update:state'
        UPDATE_DESC = 'update:desc'
        DELETE = 'delete'
        VIEW_ANNOTATIONS = 'view:annotations'
        UPDATE_ANNOTATIONS = 'update:annotations'
        DELETE_ANNOTATIONS = 'delete:annotations'
        IMPORT_ANNOTATIONS = 'import:annotations'
        EXPORT_ANNOTATIONS = 'export:annotations'
        EXPORT_DATASET = 'export:dataset'
        VIEW_COMMITS = 'view:commits'
        VIEW_DATA = 'view:data'
        VIEW_METADATA = 'view:metadata'
        UPDATE_METADATA = 'update:metadata'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'job':
            for scope in cls.get_scopes(request, view, obj):
                self = cls.create_base_perm(request, view, scope, obj)
                permissions.append(self)

            if view.action == 'issues':
                perm = IssuePermission.create_scope_list(request)
                permissions.append(perm)

            assignee_id = request.data.get('assignee')
            if assignee_id:
                perm = UserPermission.create_scope_view(request, assignee_id)
                permissions.append(perm)

        return permissions

    @classmethod
    def create_scope_view_data(cls, request, job_id):
        try:
            obj = Job.objects.get(id=job_id)
        except Job.DoesNotExist as ex:
            raise ValidationError(str(ex))
        return cls(**cls.unpack_context(request), obj=obj, scope='view:data')

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + '/jobs/allow'

    @staticmethod
    def get_scopes(request, view, obj):
        Scopes = __class__.Scopes
        scope = {
            ('list', 'GET'): Scopes.LIST, # TODO: need to add the method
            ('retrieve', 'GET'): Scopes.VIEW,
            ('partial_update', 'PATCH'): Scopes.UPDATE,
            ('update', 'PUT'): Scopes.UPDATE, # TODO: do we need the method?
            ('destroy', 'DELETE'): Scopes.DELETE,
            ('annotations', 'GET'): Scopes.VIEW_ANNOTATIONS,
            ('annotations', 'PATCH'): Scopes.UPDATE_ANNOTATIONS,
            ('annotations', 'DELETE'): Scopes.DELETE_ANNOTATIONS,
            ('annotations', 'PUT'): Scopes.UPDATE_ANNOTATIONS,
            ('annotations', 'POST'): Scopes.IMPORT_ANNOTATIONS,
            ('append_annotations_chunk', 'PATCH'): Scopes.UPDATE_ANNOTATIONS,
            ('append_annotations_chunk', 'HEAD'): Scopes.UPDATE_ANNOTATIONS,
            ('data', 'GET'): Scopes.VIEW_DATA,
            ('metadata','GET'): Scopes.VIEW_METADATA,
            ('metadata','PATCH'): Scopes.UPDATE_METADATA,
            ('issues', 'GET'): Scopes.VIEW,
            ('commits', 'GET'): Scopes.VIEW_COMMITS,
            ('dataset_export', 'GET'): Scopes.EXPORT_DATASET,
            ('preview', 'GET'): Scopes.VIEW,
        }.get((view.action, request.method))

        scopes = []
        if scope == Scopes.UPDATE:
            if any(k in request.data for k in ('owner_id', 'owner')):
                owner_id = request.data.get('owner_id') or request.data.get('owner')
                if owner_id != getattr(obj.owner, 'id', None):
                    scopes.append(Scopes.UPDATE_OWNER)
            if any(k in request.data for k in ('assignee_id', 'assignee')):
                assignee_id = request.data.get('assignee_id') or request.data.get('assignee')
                if assignee_id != getattr(obj.assignee, 'id', None):
                    scopes.append(Scopes.UPDATE_ASSIGNEE)
            if any(k in request.data for k in ('project_id', 'project')):
                project_id = request.data.get('project_id') or request.data.get('project')
                if project_id != getattr(obj.project, 'id', None):
                    scopes.append(Scopes.UPDATE_PROJECT)
            if 'stage' in request.data:
                scopes.append(Scopes.UPDATE_STAGE)
            if 'state' in request.data:
                scopes.append(Scopes.UPDATE_STATE)

            if any(k in request.data for k in ('name', 'labels', 'bug_tracker', 'subset')):
                scopes.append(Scopes.UPDATE_DESC)
        elif scope == Scopes.VIEW_ANNOTATIONS:
            if 'format' in request.query_params:
                scope = Scopes.EXPORT_ANNOTATIONS

            scopes.append(scope)
        elif scope == Scopes.UPDATE_ANNOTATIONS:
            if 'format' in request.query_params and request.method == 'PUT':
                scope = Scopes.IMPORT_ANNOTATIONS

            scopes.append(scope)
        else:
            scopes.append(scope)

        return scopes

    def get_resource(self):
        data = None
        if self.obj:
            if self.obj.segment.task.project:
                organization = self.obj.segment.task.project.organization
            else:
                organization = self.obj.segment.task.organization

            data = {
                "id": self.obj.id,
                "assignee": { "id": getattr(self.obj.assignee, 'id', None) },
                'organization': {
                    "id": getattr(organization, 'id', None)
                },
                "task": {
                    "owner": { "id": getattr(self.obj.segment.task.owner, 'id', None) },
                    "assignee": { "id": getattr(self.obj.segment.task.assignee, 'id', None) }
                },
                "project": {
                    "owner": { "id": getattr(self.obj.segment.task.project.owner, 'id', None) },
                    "assignee": { "id": getattr(self.obj.segment.task.project.assignee, 'id', None) }
                } if self.obj.segment.task.project else None
            }

        return data

class CommentPermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        LIST = 'list'
        CREATE  = 'create'
        CREATE_IN_ISSUE  = 'create@issue'
        DELETE = 'delete'
        UPDATE = 'update'
        VIEW = 'view'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'comment':
            for scope in cls.get_scopes(request, view, obj):
                self = cls.create_base_perm(request, view, scope, obj,
                    issue_id=request.data.get('issue'))
                permissions.append(self)

        return permissions

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + '/comments/allow'

    @staticmethod
    def get_scopes(request, view, obj):
        Scopes = __class__.Scopes
        return [{
            'list': Scopes.LIST,
            'create': Scopes.CREATE_IN_ISSUE,
            'destroy': Scopes.DELETE,
            'partial_update': Scopes.UPDATE,
            'retrieve': Scopes.VIEW,
        }.get(view.action, None)]

    def get_resource(self):
        data = None
        def get_common_data(db_issue):
            if db_issue.job.segment.task.project:
                organization = db_issue.job.segment.task.project.organization
            else:
                organization = db_issue.job.segment.task.organization

            data = {
                "project": {
                    "owner": { "id": getattr(db_issue.job.segment.task.project.owner, 'id', None) },
                    "assignee": { "id": getattr(db_issue.job.segment.task.project.assignee, 'id', None) }
                } if db_issue.job.segment.task.project else None,
                "task": {
                    "owner": { "id": getattr(db_issue.job.segment.task.owner, 'id', None) },
                    "assignee": { "id": getattr(db_issue.job.segment.task.assignee, 'id', None) }
                },
                "job": {
                    "assignee": { "id": getattr(db_issue.job.assignee, 'id', None) }
                },
                "issue": {
                    "owner": { "id": getattr(db_issue.owner, 'id', None) },
                    "assignee": { "id": getattr(db_issue.assignee, 'id', None) }
                },
                'organization': {
                    "id": getattr(organization, 'id', None)
                }
            }

            return data

        if self.obj:
            db_issue = self.obj.issue
            data = get_common_data(db_issue)
            data.update({
                "id": self.obj.id,
                "owner": { "id": getattr(self.obj.owner, 'id', None) }
            })
        elif self.scope.startswith(__class__.Scopes.CREATE):
            try:
                db_issue = Issue.objects.get(id=self.issue_id)
            except Issue.DoesNotExist as ex:
                raise ValidationError(str(ex))
            data = get_common_data(db_issue)
            data.update({
                "owner": { "id": self.user_id }
            })

        return data

class IssuePermission(OpenPolicyAgentPermission):
    class Scopes(StrEnum):
        LIST = 'list'
        CREATE  = 'create'
        CREATE_IN_JOB  = 'create@job'
        DELETE = 'delete'
        UPDATE = 'update'
        VIEW = 'view'

    @classmethod
    def create(cls, request, view, obj):
        permissions = []
        if view.basename == 'issue':
            assignee_id = request.data.get('assignee')
            for scope in cls.get_scopes(request, view, obj):
                self = cls.create_base_perm(request, view, scope, obj,
                    job_id=request.data.get('job'),
                    assignee_id=assignee_id)
                permissions.append(self)

            if assignee_id:
                perm = UserPermission.create_scope_view(request, assignee_id)
                permissions.append(perm)

        return permissions

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.url = settings.IAM_OPA_DATA_URL + '/issues/allow'

    @staticmethod
    def get_scopes(request, view, obj):
        Scopes = __class__.Scopes
        return [{
            'list': Scopes.LIST,
            'create': Scopes.CREATE_IN_JOB,
            'destroy': Scopes.DELETE,
            'partial_update': Scopes.UPDATE,
            'retrieve': Scopes.VIEW,
            'comments': Scopes.VIEW,
        }.get(view.action, None)]

    def get_resource(self):
        data = None
        def get_common_data(db_job):
            if db_job.segment.task.project:
                organization = db_job.segment.task.project.organization
            else:
                organization = db_job.segment.task.organization

            data = {
                "project": {
                    "owner": { "id": getattr(db_job.segment.task.project.owner, 'id', None) },
                    "assignee": { "id": getattr(db_job.segment.task.project.assignee, 'id', None) }
                } if db_job.segment.task.project else None,
                "task": {
                    "owner": { "id": getattr(db_job.segment.task.owner, 'id', None) },
                    "assignee": { "id": getattr(db_job.segment.task.assignee, 'id', None) }
                },
                "job": {
                    "assignee": { "id": getattr(db_job.assignee, 'id', None) }
                },
                'organization': {
                    "id": getattr(organization, 'id', None)
                }
            }

            return data

        if self.obj:
            db_job = self.obj.job
            data = get_common_data(db_job)
            data.update({
                "id": self.obj.id,
                "owner": { "id": getattr(self.obj.owner, 'id', None) },
                "assignee": { "id": getattr(self.obj.assignee, 'id', None) }
            })
        elif self.scope.startswith(__class__.Scopes.CREATE):
            job_id = self.job_id
            try:
                db_job = Job.objects.get(id=job_id)
            except Job.DoesNotExist as ex:
                raise ValidationError(str(ex))
            data = get_common_data(db_job)
            data.update({
                "owner": { "id": self.user_id },
                "assignee": { "id": self.assignee_id },
            })

        return data


class LimitPermission(OpenPolicyAgentPermission):
    @classmethod
    def create(cls, request, view, obj):
        return [] # There are no basic (unconditional) permissions

    @classmethod
    def create_from_scopes(cls, request, view, obj, scopes: List[OpenPolicyAgentPermission]):
        scope_to_caps = [
            (scope_handler, cls._prepare_capability_params(scope_handler))
            for scope_handler in scopes
        ]
        return [
            cls.create_base_perm(request, view, str(scope_handler.scope), obj,
                scope_handler=scope_handler, capabilities=capabilities,
            )
            for scope_handler, capabilities in scope_to_caps
            if capabilities
        ]

    def __init__(self, **kwargs):
        self.url = settings.IAM_OPA_DATA_URL + '/limits/result'
        self.scope_handler: OpenPolicyAgentPermission = kwargs.pop('scope_handler')
        self.capabilities: Tuple[Limits, CapabilityContext] = kwargs.pop('capabilities')
        super().__init__(**kwargs)

    @classmethod
    def get_scopes(cls, request, view, obj):
        scopes = [
            (scope_handler, cls._prepare_capability_params(scope_handler))
            for ctx in OpenPolicyAgentPermission.__subclasses__()
            if not issubclass(ctx, cls)
            for scope_handler in ctx.create(request, view, obj)
        ]
        return [
            (scope, capabilities)
            for scope, capabilities in scopes
            if capabilities
        ]

    def get_resource(self):
        data = {}
        limit_manager = LimitManager()

        def _get_capability_status(
            capability: Limits, context: Optional[CapabilityContext]
        ) -> dict:
            status = limit_manager.get_status(limit=capability, context=context)
            return { 'used': status.used, 'max': status.max }

        for capability, context in self.capabilities:
            data[self._get_capability_name(capability)] = _get_capability_status(
                capability=capability, context=context,
            )

        return { 'limits': data }

    @classmethod
    def _get_capability_name(cls, capability: Limits) -> str:
        return capability.name

    @classmethod
    def _prepare_capability_params(cls, scope: OpenPolicyAgentPermission
    ) -> List[Tuple[Limits, CapabilityContext]]:
        scope_id = (type(scope), scope.scope)
        results = []

        if scope_id in [
            (TaskPermission, TaskPermission.Scopes.CREATE),
            (TaskPermission, TaskPermission.Scopes.IMPORT_BACKUP),
        ]:
            if getattr(scope, 'org_id') is not None:
                results.append((
                    Limits.ORG_TASKS,
                    OrgTasksContext(org_id=scope.org_id)
                ))
            else:
                results.append((
                    Limits.USER_SANDBOX_TASKS,
                    UserSandboxTasksContext(user_id=scope.user_id)
                ))

        elif scope_id == (TaskPermission, TaskPermission.Scopes.CREATE_IN_PROJECT):
            project = Project.objects.get(id=scope.project_id)

            if getattr(project, 'organization') is not None:
                results.append((
                    Limits.TASKS_IN_ORG_PROJECT,
                    TasksInOrgProjectContext(
                        org_id=project.organization.id,
                        project_id=project.id,
                    )
                ))
                results.append((
                    Limits.ORG_TASKS,
                    OrgTasksContext(org_id=project.organization.id)
                ))
            else:
                results.append((
                    Limits.TASKS_IN_USER_SANDBOX_PROJECT,
                    TasksInUserSandboxProjectContext(
                        user_id=project.owner.id,
                        project_id=project.id
                    )
                ))
                results.append((
                    Limits.USER_SANDBOX_TASKS,
                    UserSandboxTasksContext(user_id=project.owner.id)
                ))

        elif scope_id == (TaskPermission, TaskPermission.Scopes.UPDATE_PROJECT):
            task = cast(Task, scope.obj)
            project = Project.objects.get(id=scope.project_id)

            class OwnerType(Enum):
                org = auto()
                user = auto()

            if getattr(task, 'organization', None):
                old_owner = (OwnerType.org, task.organization.id)
            else:
                old_owner = (OwnerType.user, task.owner.id)

            if getattr(project, 'organization', None) is not None:
                results.append((
                    Limits.TASKS_IN_ORG_PROJECT,
                    TasksInOrgProjectContext(
                        org_id=project.organization.id,
                        project_id=project.id,
                    )
                ))

                if old_owner != (OwnerType.org, project.organization.id):
                    results.append((
                        Limits.ORG_TASKS,
                        OrgTasksContext(org_id=project.organization.id)
                    ))
            else:
                results.append((
                    Limits.TASKS_IN_USER_SANDBOX_PROJECT,
                    TasksInUserSandboxProjectContext(
                        user_id=project.owner.id,
                        project_id=project.id
                    )
                ))

                if old_owner != (OwnerType.user, project.owner.id):
                    results.append((
                        Limits.USER_SANDBOX_TASKS,
                        UserSandboxTasksContext(user_id=project.owner.id)
                    ))

        elif scope_id == (TaskPermission, TaskPermission.Scopes.UPDATE_OWNER):
            task = cast(Task, scope.obj)

            class OwnerType(Enum):
                org = auto()
                user = auto()

            if getattr(task, 'organization', None) is not None:
                old_owner = (OwnerType.org, task.organization.id)
            else:
                old_owner = (OwnerType.user, task.owner.id)

            new_owner = getattr(scope, 'owner_id', None)
            if new_owner is not None and old_owner != (OwnerType.user, new_owner):
                results.append((
                    Limits.USER_SANDBOX_TASKS,
                    UserSandboxTasksContext(user_id=new_owner)
                ))

        elif scope_id in [
            (ProjectPermission, ProjectPermission.Scopes.CREATE),
            (ProjectPermission, ProjectPermission.Scopes.IMPORT_BACKUP),
        ]:
            if getattr(scope, 'org_id') is not None:
                results.append((
                    Limits.ORG_PROJECTS,
                    OrgTasksContext(org_id=scope.org_id)
                ))
            else:
                results.append((
                    Limits.USER_SANDBOX_PROJECTS,
                    UserSandboxTasksContext(user_id=scope.user_id)
                ))

        elif scope_id == (CloudStoragePermission, CloudStoragePermission.Scopes.CREATE):
            if getattr(scope, 'org_id') is not None:
                results.append((
                    Limits.ORG_CLOUD_STORAGES,
                    OrgCloudStoragesContext(org_id=scope.org_id)
                ))
            else:
                results.append((
                    Limits.USER_SANDBOX_CLOUD_STORAGES,
                    UserSandboxCloudStoragesContext(user_id=scope.user_id)
                ))

        elif scope_id == (OrganizationPermission, OrganizationPermission.Scopes.CREATE):
            results.append((
                Limits.USER_OWNED_ORGS,
                UserOrgsContext(user_id=scope.user_id)
            ))

        elif scope_id == (WebhookPermission, WebhookPermission.Scopes.CREATE_IN_ORG):
            results.append((
                Limits.ORG_COMMON_WEBHOOKS,
                OrgCommonWebhooksContext(org_id=scope.org_id)
            ))

        elif scope_id == (WebhookPermission, WebhookPermission.Scopes.CREATE_IN_PROJECT):
            results.append((
                Limits.PROJECT_WEBHOOKS,
                ProjectWebhooksContext(project_id=scope.project_id)
            ))

        return results


class PolicyEnforcer(BasePermission):
    # pylint: disable=no-self-use
    def check_permission(self, request, view, obj):
        # Some permissions are only needed to be checked if the action
        # is permitted in general. To achieve this, we split checks
        # into 2 groups, and check one after another.
        basic_permissions: List[OpenPolicyAgentPermission] = []
        conditional_permissions: List[OpenPolicyAgentPermission] = []

        # DRF can send OPTIONS request. Internally it will try to get
        # information about serializers for PUT and POST requests (clone
        # request and replace the http method). To avoid handling
        # ('POST', 'metadata') and ('PUT', 'metadata') in every request,
        # the condition below is enough.
        if not self.is_metadata_request(request, view):
            for perm in OpenPolicyAgentPermission.__subclasses__():
                basic_permissions.extend(perm.create(request, view, obj))

            conditional_permissions.extend(LimitPermission.create_from_scopes(
                request, view, obj, basic_permissions
            ))

        self._iam_context = request.iam_context

        allow = self._check_permissions(basic_permissions)
        if allow and conditional_permissions:
            allow = self._check_permissions(conditional_permissions)
        return allow

    def _check_permissions(self, permissions: List[OpenPolicyAgentPermission]) -> bool:
        allow = True
        reasons = []
        for perm in permissions:
            result = perm.check_access()
            allow &= result.allow
            reasons.extend(result.reasons)

        if allow:
            return True
        elif reasons:
            raise LimitsReachedException(reasons, self._iam_context)
        else:
            raise PermissionDenied("not authorized")

    def has_permission(self, request, view):
        if not view.detail:
            return self.check_permission(request, view, None)
        else:
            return True # has_object_permission will be called later

    def has_object_permission(self, request, view, obj):
        return self.check_permission(request, view, obj)

    @staticmethod
    def is_metadata_request(request, view):
        return request.method == 'OPTIONS' \
            or (request.method == 'POST' and view.action == 'metadata' and len(request.data) == 0)

class IsMemberInOrganization(BasePermission):
    message = 'You should be an active member in the organization.'

    # pylint: disable=no-self-use
    def has_permission(self, request, view):
        user = request.user
        organization = request.iam_context['organization']
        membership = request.iam_context['membership']

        if organization and not user.is_superuser:
            return membership is not None

        return True

