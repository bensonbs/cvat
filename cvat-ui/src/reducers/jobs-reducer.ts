// Copyright (C) 2022 Intel Corporation
//
// SPDX-License-Identifier: MIT

import { JobsActions, JobsActionTypes } from 'actions/jobs-actions';
import { JobsState } from '.';

const defaultState: JobsState = {
    fetching: false,
    count: 0,
    query: {
        page: 1,
        filter: null,
        sort: null,
        search: null,
    },
    current: [],
    previews: {},
};

export default (state: JobsState = defaultState, action: JobsActions): JobsState => {
    switch (action.type) {
        case JobsActionTypes.GET_JOBS: {
            return {
                ...state,
                fetching: true,
                query: {
                    ...defaultState.query,
                    ...action.payload.query,
                },
            };
        }
        case JobsActionTypes.GET_JOBS_SUCCESS: {
            return {
                ...state,
                fetching: false,
                count: action.payload.jobs.count,
                current: action.payload.jobs,
            };
        }
        case JobsActionTypes.GET_JOBS_FAILED: {
            return {
                ...state,
                fetching: false,
            };
        }
        case JobsActionTypes.GET_JOB_PREVIEW: {
            const { jobID } = action.payload;
            const { previews } = state;
            return {
                ...state,
                previews: {
                    ...previews,
                    [jobID]: {
                        preview: '',
                        fetching: true,
                        initialized: false,
                    },
                },
            };
        }
        case JobsActionTypes.GET_JOB_PREVIEW_SUCCESS: {
            const { jobID, preview } = action.payload;
            const { previews } = state;
            return {
                ...state,
                previews: {
                    ...previews,
                    [jobID]: {
                        preview,
                        fetching: false,
                        initialized: true,
                    },
                },
            };
        }
        case JobsActionTypes.GET_JOB_PREVIEW_FAILED: {
            const { jobID } = action.payload;
            const { previews } = state;
            return {
                ...state,
                previews: {
                    ...previews,
                    [jobID]: {
                        ...previews[jobID],
                        fetching: false,
                        initialized: true,
                    },
                },
            };
        }
        default: {
            return state;
        }
    }
};
