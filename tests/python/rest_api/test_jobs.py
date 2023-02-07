# Copyright (C) 2021-2022 Intel Corporation
# Copyright (C) 2022 CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

import json
import xml.etree.ElementTree as ET
import zipfile
from copy import deepcopy
from http import HTTPStatus
from io import BytesIO
from typing import List

import pytest
from cvat_sdk.core.helpers import get_paginated_collection
from deepdiff import DeepDiff
from PIL import Image

from shared.utils.config import make_api_client

from .utils import export_dataset


def get_job_staff(job, tasks, projects):
    job_staff = []
    job_staff.append(job["assignee"])
    tid = job["task_id"]
    job_staff.append(tasks[tid]["owner"])
    job_staff.append(tasks[tid]["assignee"])

    pid = job["project_id"]
    if pid:
        job_staff.append(projects[pid]["owner"])
        job_staff.append(projects[pid]["assignee"])
    job_staff = set(u["id"] for u in job_staff if u is not None)

    return job_staff


def filter_jobs(jobs, tasks, org):
    if org is None:
        kwargs = {}
        jobs = jobs.raw
    elif org == "":
        kwargs = {"org": ""}
        jobs = [job for job in jobs if tasks[job["task_id"]]["organization"] is None]
    else:
        kwargs = {"org_id": org}
        jobs = [job for job in jobs if tasks[job["task_id"]]["organization"] == org]

    return jobs, kwargs


@pytest.mark.usefixtures("restore_db_per_class")
class TestGetJobs:
    def _test_get_job_200(self, user, jid, data, **kwargs):
        with make_api_client(user) as client:
            (_, response) = client.jobs_api.retrieve(jid, **kwargs)
            assert response.status == HTTPStatus.OK
            assert (
                DeepDiff(
                    data,
                    json.loads(response.data),
                    exclude_paths="root['updated_date']",
                    ignore_order=True,
                )
                == {}
            )

    def _test_get_job_403(self, user, jid, **kwargs):
        with make_api_client(user) as client:
            (_, response) = client.jobs_api.retrieve(
                jid, **kwargs, _check_status=False, _parse_response=False
            )
            assert response.status == HTTPStatus.FORBIDDEN

    @pytest.mark.parametrize("org", [None, "", 1, 2])
    def test_admin_get_job(self, jobs, tasks, org):
        jobs, kwargs = filter_jobs(jobs, tasks, org)

        # keep only the reasonable amount of jobs
        for job in jobs[:8]:
            self._test_get_job_200("admin2", job["id"], job, **kwargs)

    @pytest.mark.parametrize("org_id", ["", None, 1, 2])
    @pytest.mark.parametrize("groups", [["business"], ["user"], ["worker"], []])
    def test_non_admin_get_job(self, org_id, groups, users, jobs, tasks, projects, org_staff):
        # keep the reasonable amount of users and jobs
        users = [u for u in users if u["groups"] == groups][:4]
        jobs, kwargs = filter_jobs(jobs, tasks, org_id)
        org_staff = org_staff(org_id)

        for job in jobs[:8]:
            job_staff = get_job_staff(job, tasks, projects)

            # check if the specific user in job_staff to see the job
            for user in users:
                if user["id"] in job_staff | org_staff:
                    self._test_get_job_200(user["username"], job["id"], job, **kwargs)
                else:
                    self._test_get_job_403(user["username"], job["id"], **kwargs)


@pytest.mark.usefixtures("restore_db_per_class")
class TestListJobs:
    def _test_list_jobs_200(self, user, data, **kwargs):
        with make_api_client(user) as client:
            results = get_paginated_collection(
                client.jobs_api.list_endpoint, return_json=True, **kwargs
            )
            assert (
                DeepDiff(data, results, exclude_paths="root['updated_date']", ignore_order=True)
                == {}
            )

    def _test_list_jobs_403(self, user, **kwargs):
        with make_api_client(user) as client:
            (_, response) = client.jobs_api.list(
                **kwargs, _check_status=False, _parse_response=False
            )
            assert response.status == HTTPStatus.FORBIDDEN

    @pytest.mark.parametrize("org", [None, "", 1, 2])
    def test_admin_list_jobs(self, jobs, tasks, org):
        jobs, kwargs = filter_jobs(jobs, tasks, org)
        self._test_list_jobs_200("admin1", jobs, **kwargs)

    @pytest.mark.parametrize("org_id", ["", None, 1, 2])
    @pytest.mark.parametrize("groups", [["business"], ["user"], ["worker"], []])
    def test_non_admin_list_jobs(
        self, org_id, groups, users, jobs, tasks, projects, org_staff, is_org_member
    ):
        users = [u for u in users if u["groups"] == groups][:2]
        jobs, kwargs = filter_jobs(jobs, tasks, org_id)
        org_staff = org_staff(org_id)

        for user in users:
            user_jobs = []
            for job in jobs:
                job_staff = get_job_staff(job, tasks, projects)
                if user["id"] in job_staff | org_staff:
                    user_jobs.append(job)
            if is_org_member(user["id"], org_id):
                self._test_list_jobs_200(user["username"], user_jobs, **kwargs)
            else:
                self._test_list_jobs_403(user["username"], **kwargs)


@pytest.mark.usefixtures("restore_db_per_class")
class TestGetAnnotations:
    def _test_get_job_annotations_200(self, user, jid, data, **kwargs):
        with make_api_client(user) as client:
            (_, response) = client.jobs_api.retrieve_annotations(jid, **kwargs)
            assert response.status == HTTPStatus.OK

            response_data = json.loads(response.data)
            assert (
                DeepDiff(data, response_data, exclude_regex_paths=r"root\['version|updated_date'\]")
                == {}
            )

    def _test_get_job_annotations_403(self, user, jid, **kwargs):
        with make_api_client(user) as client:
            (_, response) = client.jobs_api.retrieve_annotations(
                jid, **kwargs, _check_status=False, _parse_response=False
            )
            assert response.status == HTTPStatus.FORBIDDEN

    @pytest.mark.parametrize("org", [""])
    @pytest.mark.parametrize(
        "groups, job_staff, expect_success",
        [
            (["admin"], True, True),
            (["admin"], False, True),
            (["business"], True, True),
            (["business"], False, False),
            (["worker"], True, True),
            (["worker"], False, False),
            (["user"], True, True),
            (["user"], False, False),
        ],
    )
    def test_user_get_job_annotations(
        self,
        org,
        groups,
        job_staff,
        expect_success,
        users,
        jobs,
        tasks,
        annotations,
        find_job_staff_user,
    ):
        users = [u for u in users if u["groups"] == groups]
        jobs, kwargs = filter_jobs(jobs, tasks, org)
        username, job_id = find_job_staff_user(jobs, users, job_staff)

        if expect_success:
            self._test_get_job_annotations_200(
                username, job_id, annotations["job"][str(job_id)], **kwargs
            )
        else:
            self._test_get_job_annotations_403(username, job_id, **kwargs)

    @pytest.mark.parametrize("org", [2])
    @pytest.mark.parametrize(
        "role, job_staff, expect_success",
        [
            ("owner", True, True),
            ("owner", False, True),
            ("maintainer", True, True),
            ("maintainer", False, True),
            ("supervisor", True, True),
            ("supervisor", False, False),
            ("worker", True, True),
            ("worker", False, False),
        ],
    )
    def test_member_get_job_annotations(
        self,
        org,
        role,
        job_staff,
        expect_success,
        jobs,
        tasks,
        find_job_staff_user,
        annotations,
        find_users,
    ):
        users = find_users(org=org, role=role)
        jobs, kwargs = filter_jobs(jobs, tasks, org)
        username, jid = find_job_staff_user(jobs, users, job_staff)

        if expect_success:
            data = annotations["job"][str(jid)]
            data["shapes"] = sorted(data["shapes"], key=lambda a: a["id"])
            self._test_get_job_annotations_200(username, jid, data, **kwargs)
        else:
            self._test_get_job_annotations_403(username, jid, **kwargs)

    @pytest.mark.parametrize("org", [1])
    @pytest.mark.parametrize(
        "privilege, expect_success",
        [("admin", True), ("business", False), ("worker", False), ("user", False)],
    )
    def test_non_member_get_job_annotations(
        self,
        org,
        privilege,
        expect_success,
        jobs,
        tasks,
        find_job_staff_user,
        annotations,
        find_users,
    ):
        users = find_users(privilege=privilege, exclude_org=org)
        jobs, kwargs = filter_jobs(jobs, tasks, org)
        username, job_id = find_job_staff_user(jobs, users, False)

        kwargs = {"org_id": org}
        if expect_success:
            self._test_get_job_annotations_200(
                username, job_id, annotations["job"][str(job_id)], **kwargs
            )
        else:
            self._test_get_job_annotations_403(username, job_id, **kwargs)


@pytest.mark.usefixtures("restore_db_per_function")
class TestPatchJobAnnotations:
    def _check_respone(self, username, jid, expect_success, data=None, org=None):
        kwargs = {}
        if org is not None:
            if isinstance(org, str):
                kwargs["org"] = org
            else:
                kwargs["org_id"] = org

        with make_api_client(username) as client:
            (_, response) = client.jobs_api.partial_update_annotations(
                id=jid,
                patched_labeled_data_request=deepcopy(data),
                action="update",
                **kwargs,
                _parse_response=expect_success,
                _check_status=expect_success,
            )

            if expect_success:
                assert response.status == HTTPStatus.OK
                assert (
                    DeepDiff(
                        data,
                        json.loads(response.data),
                        exclude_regex_paths=r"root\['version|updated_date'\]",
                    )
                    == {}
                )
            else:
                assert response.status == HTTPStatus.FORBIDDEN

    @pytest.fixture(scope="class")
    def request_data(self, annotations):
        def get_data(jid):
            data = deepcopy(annotations["job"][str(jid)])
            data["shapes"][0].update({"points": [2.0, 3.0, 4.0, 5.0, 6.0, 7.0]})
            data["version"] += 1
            return data

        return get_data

    @pytest.mark.parametrize("org", [2])
    @pytest.mark.parametrize(
        "role, job_staff, expect_success",
        [
            ("maintainer", False, True),
            ("owner", False, True),
            ("supervisor", False, False),
            ("worker", False, False),
            ("maintainer", True, True),
            ("owner", True, True),
            ("supervisor", True, True),
            ("worker", True, True),
        ],
    )
    def test_member_update_job_annotations(
        self,
        org,
        role,
        job_staff,
        expect_success,
        find_job_staff_user,
        find_users,
        request_data,
        jobs_by_org,
        filter_jobs_with_shapes,
    ):
        users = find_users(role=role, org=org)
        jobs = jobs_by_org[org]
        filtered_jobs = filter_jobs_with_shapes(jobs)
        username, jid = find_job_staff_user(filtered_jobs, users, job_staff, [18])

        data = request_data(jid)
        self._check_respone(username, jid, expect_success, data, org=org)

    @pytest.mark.parametrize("org", [2])
    @pytest.mark.parametrize(
        "privilege, expect_success",
        [("admin", True), ("business", False), ("worker", False), ("user", False)],
    )
    def test_non_member_update_job_annotations(
        self,
        org,
        privilege,
        expect_success,
        find_job_staff_user,
        find_users,
        request_data,
        jobs_by_org,
        filter_jobs_with_shapes,
    ):
        users = find_users(privilege=privilege, exclude_org=org)
        jobs = jobs_by_org[org]
        filtered_jobs = filter_jobs_with_shapes(jobs)
        username, jid = find_job_staff_user(filtered_jobs, users, False, [18])

        data = request_data(jid)
        self._check_respone(username, jid, expect_success, data, org=org)

    @pytest.mark.parametrize("org", [""])
    @pytest.mark.parametrize(
        "privilege, job_staff, expect_success",
        [
            ("admin", True, True),
            ("admin", False, True),
            ("business", True, True),
            ("business", False, False),
            ("worker", True, True),
            ("worker", False, False),
            ("user", True, True),
            ("user", False, False),
        ],
    )
    def test_user_update_job_annotations(
        self,
        org,
        privilege,
        job_staff,
        expect_success,
        find_job_staff_user,
        find_users,
        request_data,
        jobs_by_org,
        filter_jobs_with_shapes,
    ):
        users = find_users(privilege=privilege)
        jobs = jobs_by_org[org]
        filtered_jobs = filter_jobs_with_shapes(jobs)
        username, jid = find_job_staff_user(filtered_jobs, users, job_staff)

        data = request_data(jid)
        self._check_respone(username, jid, expect_success, data, org=org)


@pytest.mark.usefixtures("restore_db_per_function")
class TestPatchJob:
    @pytest.fixture(scope="class")
    def find_task_staff_user(self, is_task_staff):
        def find(jobs, users, is_staff):
            for job in jobs:
                for user in users:
                    if is_staff == is_task_staff(user["id"], job["task_id"]):
                        return user, job["id"]
            return None, None

        return find

    @pytest.fixture(scope="class")
    def expected_data(self, jobs, users):
        keys = ["url", "id", "username", "first_name", "last_name"]

        def find(job_id, assignee_id):
            data = deepcopy(jobs[job_id])
            data["assignee"] = dict(filter(lambda a: a[0] in keys, users[assignee_id].items()))
            return data

        return find

    @pytest.fixture(scope="class")
    def new_assignee(self, jobs, tasks, assignee_id, org_staff):
        def find_new_assignee(jid, user_id):
            members = org_staff(tasks[jobs[jid]["task_id"]]["organization"])
            members -= {assignee_id(jobs[jid]), user_id}
            return members.pop()

        return find_new_assignee

    @pytest.mark.parametrize("org", [2])
    @pytest.mark.parametrize(
        "role, task_staff, expect_success",
        [
            ("maintainer", False, True),
            ("owner", False, True),
            ("supervisor", False, False),
            ("worker", False, False),
            ("maintainer", True, True),
            ("owner", True, True),
            ("supervisor", True, True),
            ("worker", True, True),
        ],
    )
    def test_member_update_job_assignee(
        self,
        org,
        role,
        task_staff,
        expect_success,
        find_task_staff_user,
        find_users,
        jobs_by_org,
        new_assignee,
        expected_data,
    ):
        users, jobs = find_users(role=role, org=org), jobs_by_org[org]
        user, jid = find_task_staff_user(jobs, users, task_staff)

        assignee = new_assignee(jid, user["id"])
        with make_api_client(user["username"]) as client:
            (_, response) = client.jobs_api.partial_update(
                id=jid,
                patched_job_write_request={"assignee": assignee},
                org_id=org,
                _parse_response=expect_success,
                _check_status=expect_success,
            )

            if expect_success:
                assert response.status == HTTPStatus.OK
                assert (
                    DeepDiff(
                        expected_data(jid, assignee),
                        json.loads(response.data),
                        exclude_paths="root['updated_date']",
                        ignore_order=True,
                    )
                    == {}
                )
            else:
                assert response.status == HTTPStatus.FORBIDDEN


def _check_coco_job_annotations(content, values_to_be_checked):
    exported_annotations = json.loads(content)
    assert values_to_be_checked["shapes_length"] == len(exported_annotations["annotations"])
    assert values_to_be_checked["job_size"] == len(exported_annotations["images"])
    assert values_to_be_checked["task_size"] > len(exported_annotations["images"])


def _check_cvat_job_annotations(content, values_to_be_checked):
    document = ET.fromstring(content)
    # check meta information
    meta = document.find("meta")
    instance = list(meta)[0]
    assert instance.tag == "job"
    assert instance.find("id").text == values_to_be_checked["job_id"]
    assert instance.find("size").text == str(values_to_be_checked["job_size"])
    assert instance.find("start_frame").text == str(values_to_be_checked["start_frame"])
    assert instance.find("stop_frame").text == str(values_to_be_checked["stop_frame"])
    assert instance.find("mode").text == values_to_be_checked["mode"]
    assert len(instance.find("segments")) == 1

    # check number of images, their sorting, number of annotations
    images = document.findall("image")
    assert len(images) == values_to_be_checked["job_size"]
    assert len(list(document.iter("box"))) == values_to_be_checked["shapes_length"]
    current_id = values_to_be_checked["start_frame"]
    for image_elem in images:
        assert image_elem.attrib["id"] == str(current_id)
        current_id += 1


@pytest.mark.usefixtures("restore_db_per_class")
class TestJobDataset:
    def _export_dataset(self, username, jid, **kwargs):
        with make_api_client(username) as api_client:
            return export_dataset(api_client.jobs_api.retrieve_dataset_endpoint, id=jid, **kwargs)

    def _export_annotations(self, username, jid, **kwargs):
        with make_api_client(username) as api_client:
            return export_dataset(
                api_client.jobs_api.retrieve_annotations_endpoint, id=jid, **kwargs
            )

    def test_can_export_dataset(self, admin_user: str, jobs_with_shapes: List):
        job = jobs_with_shapes[0]
        response = self._export_dataset(admin_user, job["id"], format="CVAT for images 1.1")
        assert response.data

    def test_non_admin_can_export_dataset(self, users, tasks, jobs_with_shapes):
        job_id, username = next(
            (
                (job["id"], tasks[job["task_id"]]["owner"]["username"])
                for job in jobs_with_shapes
                if "admin" not in users[tasks[job["task_id"]]["owner"]["id"]]["groups"]
                and tasks[job["task_id"]]["target_storage"] is None
                and tasks[job["task_id"]]["organization"] is None
            )
        )
        response = self._export_dataset(username, job_id, format="CVAT for images 1.1")
        assert response.data

    def test_non_admin_can_export_annotations(self, users, tasks, jobs_with_shapes):
        job_id, username = next(
            (
                (job["id"], tasks[job["task_id"]]["owner"]["username"])
                for job in jobs_with_shapes
                if "admin" not in users[tasks[job["task_id"]]["owner"]["id"]]["groups"]
                and tasks[job["task_id"]]["target_storage"] is None
                and tasks[job["task_id"]]["organization"] is None
            )
        )
        response = self._export_annotations(username, job_id, format="CVAT for images 1.1")
        assert response.data

    @pytest.mark.parametrize("username, jid", [("admin1", 14)])
    @pytest.mark.parametrize(
        "anno_format, anno_file_name, check_func",
        [
            ("COCO 1.0", "annotations/instances_default.json", _check_coco_job_annotations),
            ("CVAT for images 1.1", "annotations.xml", _check_cvat_job_annotations),
        ],
    )
    def test_exported_job_dataset_structure(
        self,
        username,
        jid,
        anno_format,
        anno_file_name,
        check_func,
        tasks,
        jobs,
        annotations,
    ):
        job_data = jobs[jid]
        annotations_before = annotations["job"][str(jid)]

        values_to_be_checked = {
            "task_size": tasks[job_data["task_id"]]["size"],
            # NOTE: data step is not stored in assets, default = 1
            "job_size": job_data["stop_frame"] - job_data["start_frame"] + 1,
            "start_frame": job_data["start_frame"],
            "stop_frame": job_data["stop_frame"],
            "shapes_length": len(annotations_before["shapes"]),
            "job_id": str(jid),
            "mode": job_data["mode"],
        }

        response = self._export_dataset(username, jid, format=anno_format)
        assert response.data
        with zipfile.ZipFile(BytesIO(response.data)) as zip_file:
            assert (
                len(zip_file.namelist()) == values_to_be_checked["job_size"] + 1
            )  # images + annotation file
            content = zip_file.read(anno_file_name)
        check_func(content, values_to_be_checked)


@pytest.mark.usefixtures("restore_db_per_class")
class TestGetJobPreview:
    def _test_get_job_preview_200(self, username, jid, **kwargs):
        with make_api_client(username) as client:
            (_, response) = client.jobs_api.retrieve_preview(jid, **kwargs)

            assert response.status == HTTPStatus.OK
            (width, height) = Image.open(BytesIO(response.data)).size
            assert width > 0 and height > 0

    def _test_get_job_preview_403(self, username, jid, **kwargs):
        with make_api_client(username) as client:
            (_, response) = client.jobs_api.retrieve(
                jid, **kwargs, _check_status=False, _parse_response=False
            )
            assert response.status == HTTPStatus.FORBIDDEN

    @pytest.mark.parametrize("org", [None, "", 1, 2])
    def test_admin_get_job_preview(self, jobs, tasks, org):
        jobs, kwargs = filter_jobs(jobs, tasks, org)

        # keep only the reasonable amount of jobs
        for job in jobs[:8]:
            self._test_get_job_preview_200("admin2", job["id"], **kwargs)

    @pytest.mark.parametrize("org_id", ["", None, 1, 2])
    @pytest.mark.parametrize("groups", [["business"], ["user"], ["worker"], []])
    def test_non_admin_get_job_preview(
        self, org_id, groups, users, jobs, tasks, projects, org_staff
    ):
        # keep the reasonable amount of users and jobs
        users = [u for u in users if u["groups"] == groups][:4]
        jobs, kwargs = filter_jobs(jobs, tasks, org_id)
        org_staff = org_staff(org_id)

        for job in jobs[:8]:
            job_staff = get_job_staff(job, tasks, projects)

            # check if the specific user in job_staff to see the job preview
            for user in users:
                if user["id"] in job_staff | org_staff:
                    self._test_get_job_preview_200(user["username"], job["id"], **kwargs)
                else:
                    self._test_get_job_preview_403(user["username"], job["id"], **kwargs)
