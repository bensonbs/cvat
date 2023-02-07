// Copyright (C) 2020-2022 Intel Corporation
// Copyright (C) 2022 CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import React from 'react';
import { connect } from 'react-redux';

import JobListComponent from 'components/task-page/job-list';
import { updateJobAsync } from 'actions/tasks-actions';
import { Task } from 'reducers';

interface OwnProps {
    task: Task;
}

interface DispatchToProps {
    onJobUpdate(jobInstance: any): void;
}

function mapDispatchToProps(dispatch: any): DispatchToProps {
    return {
        onJobUpdate: (jobInstance: any): void => dispatch(updateJobAsync(jobInstance)),
    };
}

function TaskPageContainer(props: DispatchToProps & OwnProps): JSX.Element {
    const { task, onJobUpdate } = props;

    return <JobListComponent taskInstance={task} onJobUpdate={onJobUpdate} />;
}

export default connect(null, mapDispatchToProps)(TaskPageContainer);
