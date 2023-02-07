import { ArgumentError, DataError } from './exceptions';
import { HistoryActions } from './enums';
import loggerStorage from './logger-storage';
import serverProxy from './server-proxy';
import {
    getFrame,
    deleteFrame,
    restoreFrame,
    getRanges,
    getPreview,
    clear as clearFrames,
    findNotDeletedFrame,
    getContextImage,
    patchMeta,
    getDeletedFrames,
} from './frames';
import Issue from './issue';
import { checkObjectType } from './common';
import {
    getAnnotations, putAnnotations, saveAnnotations,
    hasUnsavedChanges, searchAnnotations, searchEmptyFrame,
    mergeAnnotations, splitAnnotations, groupAnnotations,
    clearAnnotations, selectObject, annotationsStatistics,
    importCollection, exportCollection, importDataset,
    exportDataset, undoActions, redoActions,
    freezeHistory, clearActions, getActions,
    clearCache, getHistory,
} from './annotations';

// must be called with task/job context
async function deleteFrameWrapper(jobID, frame) {
    const history = getHistory(this);
    const redo = async () => {
        deleteFrame(jobID, frame);
    };

    await redo();
    history.do(HistoryActions.REMOVED_FRAME, async () => {
        restoreFrame(jobID, frame);
    }, redo, [], frame);
}

async function restoreFrameWrapper(jobID, frame) {
    const history = getHistory(this);
    const redo = async () => {
        restoreFrame(jobID, frame);
    };

    await redo();
    history.do(HistoryActions.RESTORED_FRAME, async () => {
        deleteFrame(jobID, frame);
    }, redo, [], frame);
}

export function implementJob(Job) {
    Job.prototype.save.implementation = async function () {
        if (this.id) {
            const jobData = this._updateTrigger.getUpdated(this);
            if (jobData.assignee) {
                jobData.assignee = jobData.assignee.id;
            }

            const data = await serverProxy.jobs.save(this.id, jobData);
            this._updateTrigger.reset();
            return new Job(data);
        }

        throw new ArgumentError('Could not save job without id');
    };

    Job.prototype.issues.implementation = async function () {
        const result = await serverProxy.issues.get(this.id);
        return result.map((issue) => new Issue(issue));
    };

    Job.prototype.openIssue.implementation = async function (issue, message) {
        checkObjectType('issue', issue, null, Issue);
        checkObjectType('message', message, 'string');
        const result = await serverProxy.issues.create({
            ...issue.serialize(),
            message,
        });
        return new Issue(result);
    };

    Job.prototype.frames.get.implementation = async function (frame, isPlaying, step) {
        if (!Number.isInteger(frame) || frame < 0) {
            throw new ArgumentError(`Frame must be a positive integer. Got: "${frame}"`);
        }

        if (frame < this.startFrame || frame > this.stopFrame) {
            throw new ArgumentError(`The frame with number ${frame} is out of the job`);
        }

        const frameData = await getFrame(
            this.id,
            this.dataChunkSize,
            this.dataChunkType,
            this.mode,
            frame,
            this.startFrame,
            this.stopFrame,
            isPlaying,
            step,
            this.dimension,
        );
        return frameData;
    };

    Job.prototype.frames.delete.implementation = async function (frame) {
        if (!Number.isInteger(frame)) {
            throw new Error(`Frame must be an integer. Got: "${frame}"`);
        }

        if (frame < this.startFrame || frame > this.stopFrame) {
            throw new Error('The frame is out of the job');
        }

        await deleteFrameWrapper.call(this, this.id, frame);
    };

    Job.prototype.frames.restore.implementation = async function (frame) {
        if (!Number.isInteger(frame)) {
            throw new Error(`Frame must be an integer. Got: "${frame}"`);
        }

        if (frame < this.startFrame || frame > this.stopFrame) {
            throw new Error('The frame is out of the job');
        }

        await restoreFrameWrapper.call(this, this.id, frame);
    };

    Job.prototype.frames.save.implementation = async function () {
        const result = await patchMeta(this.id);
        return result;
    };

    Job.prototype.frames.ranges.implementation = async function () {
        const rangesData = await getRanges(this.id);
        return rangesData;
    };

    Job.prototype.frames.preview.implementation = async function () {
        if (this.id === null || this.taskId === null) {
            return '';
        }

        const frameData = await getPreview(this.taskId, this.id);
        return frameData;
    };

    Job.prototype.frames.contextImage.implementation = async function (frameId) {
        const result = await getContextImage(this.id, frameId);
        return result;
    };

    Job.prototype.frames.search.implementation = async function (filters, frameFrom, frameTo) {
        if (typeof filters !== 'object') {
            throw new ArgumentError('Filters should be an object');
        }

        if (!Number.isInteger(frameFrom) || !Number.isInteger(frameTo)) {
            throw new ArgumentError('The start and end frames both must be an integer');
        }

        if (frameFrom < this.startFrame || frameFrom > this.stopFrame) {
            throw new ArgumentError('The start frame is out of the job');
        }

        if (frameTo < this.startFrame || frameTo > this.stopFrame) {
            throw new ArgumentError('The stop frame is out of the job');
        }
        if (filters.notDeleted) {
            return findNotDeletedFrame(this.id, frameFrom, frameTo, filters.offset || 1);
        }
        return null;
    };

    // TODO: Check filter for annotations
    Job.prototype.annotations.get.implementation = async function (frame, allTracks, filters) {
        if (!Array.isArray(filters)) {
            throw new ArgumentError('Filters must be an array');
        }

        if (!Number.isInteger(frame)) {
            throw new ArgumentError('The frame argument must be an integer');
        }

        if (frame < this.startFrame || frame > this.stopFrame) {
            throw new ArgumentError(`Frame ${frame} does not exist in the job`);
        }

        const annotationsData = await getAnnotations(this, frame, allTracks, filters);
        const deletedFrames = await getDeletedFrames('job', this.id);
        if (frame in deletedFrames) {
            return [];
        }

        return annotationsData;
    };

    Job.prototype.annotations.search.implementation = function (filters, frameFrom, frameTo) {
        if (!Array.isArray(filters)) {
            throw new ArgumentError('Filters must be an array');
        }

        if (!Number.isInteger(frameFrom) || !Number.isInteger(frameTo)) {
            throw new ArgumentError('The start and end frames both must be an integer');
        }

        if (frameFrom < this.startFrame || frameFrom > this.stopFrame) {
            throw new ArgumentError('The start frame is out of the job');
        }

        if (frameTo < this.startFrame || frameTo > this.stopFrame) {
            throw new ArgumentError('The stop frame is out of the job');
        }

        const result = searchAnnotations(this, filters, frameFrom, frameTo);
        return result;
    };

    Job.prototype.annotations.searchEmpty.implementation = function (frameFrom, frameTo) {
        if (!Number.isInteger(frameFrom) || !Number.isInteger(frameTo)) {
            throw new ArgumentError('The start and end frames both must be an integer');
        }

        if (frameFrom < this.startFrame || frameFrom > this.stopFrame) {
            throw new ArgumentError('The start frame is out of the job');
        }

        if (frameTo < this.startFrame || frameTo > this.stopFrame) {
            throw new ArgumentError('The stop frame is out of the job');
        }

        const result = searchEmptyFrame(this, frameFrom, frameTo);
        return result;
    };

    Job.prototype.annotations.save.implementation = async function (onUpdate) {
        const result = await saveAnnotations(this, onUpdate);
        return result;
    };

    Job.prototype.annotations.merge.implementation = async function (objectStates) {
        const result = await mergeAnnotations(this, objectStates);
        return result;
    };

    Job.prototype.annotations.split.implementation = async function (objectState, frame) {
        const result = await splitAnnotations(this, objectState, frame);
        return result;
    };

    Job.prototype.annotations.group.implementation = async function (objectStates, reset) {
        const result = await groupAnnotations(this, objectStates, reset);
        return result;
    };

    Job.prototype.annotations.hasUnsavedChanges.implementation = function () {
        const result = hasUnsavedChanges(this);
        return result;
    };

    Job.prototype.annotations.clear.implementation = async function (
        reload, startframe, endframe, delTrackKeyframesOnly,
    ) {
        const result = await clearAnnotations(this, reload, startframe, endframe, delTrackKeyframesOnly);
        return result;
    };

    Job.prototype.annotations.select.implementation = function (frame, x, y) {
        const result = selectObject(this, frame, x, y);
        return result;
    };

    Job.prototype.annotations.statistics.implementation = function () {
        const result = annotationsStatistics(this);
        return result;
    };

    Job.prototype.annotations.put.implementation = function (objectStates) {
        const result = putAnnotations(this, objectStates);
        return result;
    };

    Job.prototype.annotations.upload.implementation = async function (
        format: string,
        useDefaultLocation: boolean,
        sourceStorage: Storage,
        file: File | string,
        options?: { convMaskToPoly?: boolean },
    ) {
        const result = await importDataset(this, format, useDefaultLocation, sourceStorage, file, options);
        return result;
    };

    Job.prototype.annotations.import.implementation = function (data) {
        const result = importCollection(this, data);
        return result;
    };

    Job.prototype.annotations.export.implementation = function () {
        const result = exportCollection(this);
        return result;
    };

    Job.prototype.annotations.exportDataset.implementation = async function (
        format: string,
        saveImages: boolean,
        useDefaultSettings: boolean,
        targetStorage: Storage,
        customName?: string,
    ) {
        const result = await exportDataset(this, format, saveImages, useDefaultSettings, targetStorage, customName);
        return result;
    };

    Job.prototype.actions.undo.implementation = async function (count) {
        const result = await undoActions(this, count);
        return result;
    };

    Job.prototype.actions.redo.implementation = async function (count) {
        const result = await redoActions(this, count);
        return result;
    };

    Job.prototype.actions.freeze.implementation = function (frozen) {
        const result = freezeHistory(this, frozen);
        return result;
    };

    Job.prototype.actions.clear.implementation = function () {
        const result = clearActions(this);
        return result;
    };

    Job.prototype.actions.get.implementation = function () {
        const result = getActions(this);
        return result;
    };

    Job.prototype.logger.log.implementation = async function (logType, payload, wait) {
        const result = await loggerStorage.log(logType, { ...payload, task_id: this.taskId, job_id: this.id }, wait);
        return result;
    };

    Job.prototype.predictor.status.implementation = async function () {
        if (!Number.isInteger(this.projectId)) {
            throw new DataError('The job must belong to a project to use the feature');
        }

        const result = await serverProxy.predictor.status(this.projectId);
        return {
            message: result.message,
            progress: result.progress,
            projectScore: result.score,
            timeRemaining: result.time_remaining,
            mediaAmount: result.media_amount,
            annotationAmount: result.annotation_amount,
        };
    };

    Job.prototype.predictor.predict.implementation = async function (frame) {
        if (!Number.isInteger(frame) || frame < 0) {
            throw new ArgumentError(`Frame must be a positive integer. Got: "${frame}"`);
        }

        if (frame < this.startFrame || frame > this.stopFrame) {
            throw new ArgumentError(`The frame with number ${frame} is out of the job`);
        }

        if (!Number.isInteger(this.projectId)) {
            throw new DataError('The job must belong to a project to use the feature');
        }

        const result = await serverProxy.predictor.predict(this.taskId, frame);
        return result;
    };

    Job.prototype.close.implementation = function closeTask() {
        clearFrames(this.id);
        clearCache(this);
        return this;
    };

    return Job;
}

export function implementTask(Task) {
    Task.prototype.close.implementation = function closeTask() {
        for (const job of this.jobs) {
            clearFrames(job.id);
            clearCache(job);
        }

        clearCache(this);
        return this;
    };

    Task.prototype.save.implementation = async function (onUpdate) {
        // TODO: Add ability to change an owner and an assignee
        if (typeof this.id !== 'undefined') {
            // If the task has been already created, we update it
            const taskData = this._updateTrigger.getUpdated(this, {
                bugTracker: 'bug_tracker',
                projectId: 'project_id',
                assignee: 'assignee_id',
            });
            if (taskData.assignee_id) {
                taskData.assignee_id = taskData.assignee_id.id;
            }
            if (taskData.labels) {
                taskData.labels = this._internalData.labels;
                taskData.labels = taskData.labels.map((el) => el.toJSON());
            }

            const data = await serverProxy.tasks.save(this.id, taskData);
            this._updateTrigger.reset();
            return new Task(data);
        }

        const taskSpec: any = {
            name: this.name,
            labels: this.labels.map((el) => el.toJSON()),
        };

        if (typeof this.bugTracker !== 'undefined') {
            taskSpec.bug_tracker = this.bugTracker;
        }
        if (typeof this.segmentSize !== 'undefined') {
            taskSpec.segment_size = this.segmentSize;
        }
        if (typeof this.overlap !== 'undefined') {
            taskSpec.overlap = this.overlap;
        }
        if (typeof this.projectId !== 'undefined') {
            taskSpec.project_id = this.projectId;
        }
        if (typeof this.subset !== 'undefined') {
            taskSpec.subset = this.subset;
        }

        if (this.targetStorage) {
            taskSpec.target_storage = this.targetStorage.toJSON();
        }

        if (this.sourceStorage) {
            taskSpec.source_storage = this.sourceStorage.toJSON();
        }

        const taskDataSpec = {
            client_files: this.clientFiles,
            server_files: this.serverFiles,
            remote_files: this.remoteFiles,
            image_quality: this.imageQuality,
            use_zip_chunks: this.useZipChunks,
            use_cache: this.useCache,
            sorting_method: this.sortingMethod,
        };

        if (typeof this.startFrame !== 'undefined') {
            taskDataSpec.start_frame = this.startFrame;
        }
        if (typeof this.stopFrame !== 'undefined') {
            taskDataSpec.stop_frame = this.stopFrame;
        }
        if (typeof this.frameFilter !== 'undefined') {
            taskDataSpec.frame_filter = this.frameFilter;
        }
        if (typeof this.dataChunkSize !== 'undefined') {
            taskDataSpec.chunk_size = this.dataChunkSize;
        }
        if (typeof this.copyData !== 'undefined') {
            taskDataSpec.copy_data = this.copyData;
        }
        if (typeof this.cloudStorageId !== 'undefined') {
            taskDataSpec.cloud_storage_id = this.cloudStorageId;
        }

        const task = await serverProxy.tasks.create(taskSpec, taskDataSpec, onUpdate);
        return new Task(task);
    };

    Task.prototype.delete.implementation = async function () {
        const result = await serverProxy.tasks.delete(this.id);
        return result;
    };

    Task.prototype.backup.implementation = async function (
        targetStorage: Storage,
        useDefaultSettings: boolean,
        fileName?: string,
    ) {
        const result = await serverProxy.tasks.backup(this.id, targetStorage, useDefaultSettings, fileName);
        return result;
    };

    Task.restore.implementation = async function (storage: Storage, file: File | string) {
        // eslint-disable-next-line no-unsanitized/method
        const result = await serverProxy.tasks.restore(storage, file);
        return result;
    };

    Task.prototype.frames.get.implementation = async function (frame, isPlaying, step) {
        if (!Number.isInteger(frame) || frame < 0) {
            throw new ArgumentError(`Frame must be a positive integer. Got: "${frame}"`);
        }

        if (frame >= this.size) {
            throw new ArgumentError(`The frame with number ${frame} is out of the task`);
        }

        const job = this.jobs.filter((_job) => _job.startFrame <= frame && _job.stopFrame >= frame)[0];

        const result = await getFrame(
            job.id,
            this.dataChunkSize,
            this.dataChunkType,
            this.mode,
            frame,
            job.startFrame,
            job.stopFrame,
            isPlaying,
            step,
        );
        return result;
    };

    Task.prototype.frames.ranges.implementation = async function () {
        const rangesData = {
            decoded: [],
            buffered: [],
        };
        for (const job of this.jobs) {
            const { decoded, buffered } = await getRanges(job.id);
            rangesData.decoded.push(decoded);
            rangesData.buffered.push(buffered);
        }
        return rangesData;
    };

    Task.prototype.frames.preview.implementation = async function () {
        if (this.id === null) {
            return '';
        }

        const frameData = await getPreview(this.id);
        return frameData;
    };

    Task.prototype.frames.delete.implementation = async function (frame) {
        if (!Number.isInteger(frame)) {
            throw new Error(`Frame must be an integer. Got: "${frame}"`);
        }

        if (frame < 0 || frame >= this.size) {
            throw new Error('The frame is out of the task');
        }

        const job = this.jobs.filter((_job) => _job.startFrame <= frame && _job.stopFrame >= frame)[0];
        if (job) {
            await deleteFrameWrapper.call(this, job.id, frame);
        }
    };

    Task.prototype.frames.restore.implementation = async function (frame) {
        if (!Number.isInteger(frame)) {
            throw new Error(`Frame must be an integer. Got: "${frame}"`);
        }

        if (frame < 0 || frame >= this.size) {
            throw new Error('The frame is out of the task');
        }

        const job = this.jobs.filter((_job) => _job.startFrame <= frame && _job.stopFrame >= frame)[0];
        if (job) {
            await restoreFrameWrapper.call(this, job.id, frame);
        }
    };

    Task.prototype.frames.save.implementation = async function () {
        return Promise.all(this.jobs.map((job) => patchMeta(job.id)));
    };

    Task.prototype.frames.search.implementation = async function (filters, frameFrom, frameTo) {
        if (typeof filters !== 'object') {
            throw new ArgumentError('Filters should be an object');
        }

        if (!Number.isInteger(frameFrom) || !Number.isInteger(frameTo)) {
            throw new ArgumentError('The start and end frames both must be an integer');
        }

        if (frameFrom < 0 || frameFrom > this.size) {
            throw new ArgumentError('The start frame is out of the task');
        }

        if (frameTo < 0 || frameTo > this.size) {
            throw new ArgumentError('The stop frame is out of the task');
        }

        const jobs = this.jobs.filter((_job) => (
            (frameFrom >= _job.startFrame && frameFrom <= _job.stopFrame) ||
            (frameTo >= _job.startFrame && frameTo <= _job.stopFrame) ||
            (frameFrom < _job.startFrame && frameTo > _job.stopFrame)
        ));

        if (filters.notDeleted) {
            for (const job of jobs) {
                const result = await findNotDeletedFrame(
                    job.id, Math.max(frameFrom, job.startFrame), Math.min(frameTo, job.stopFrame), 1,
                );

                if (result !== null) return result;
            }
        }

        return null;
    };

    // TODO: Check filter for annotations
    Task.prototype.annotations.get.implementation = async function (frame, allTracks, filters) {
        if (!Array.isArray(filters) || filters.some((filter) => typeof filter !== 'string')) {
            throw new ArgumentError('The filters argument must be an array of strings');
        }

        if (!Number.isInteger(frame) || frame < 0) {
            throw new ArgumentError(`Frame must be a positive integer. Got: "${frame}"`);
        }

        if (frame >= this.size) {
            throw new ArgumentError(`Frame ${frame} does not exist in the task`);
        }

        const result = await getAnnotations(this, frame, allTracks, filters);
        const deletedFrames = await getDeletedFrames('task', this.id);
        if (frame in deletedFrames) {
            return [];
        }

        return result;
    };

    Task.prototype.annotations.search.implementation = function (filters, frameFrom, frameTo) {
        if (!Array.isArray(filters) || filters.some((filter) => typeof filter !== 'string')) {
            throw new ArgumentError('The filters argument must be an array of strings');
        }

        if (!Number.isInteger(frameFrom) || !Number.isInteger(frameTo)) {
            throw new ArgumentError('The start and end frames both must be an integer');
        }

        if (frameFrom < 0 || frameFrom >= this.size) {
            throw new ArgumentError('The start frame is out of the task');
        }

        if (frameTo < 0 || frameTo >= this.size) {
            throw new ArgumentError('The stop frame is out of the task');
        }

        const result = searchAnnotations(this, filters, frameFrom, frameTo);
        return result;
    };

    Task.prototype.annotations.searchEmpty.implementation = function (frameFrom, frameTo) {
        if (!Number.isInteger(frameFrom) || !Number.isInteger(frameTo)) {
            throw new ArgumentError('The start and end frames both must be an integer');
        }

        if (frameFrom < 0 || frameFrom >= this.size) {
            throw new ArgumentError('The start frame is out of the task');
        }

        if (frameTo < 0 || frameTo >= this.size) {
            throw new ArgumentError('The stop frame is out of the task');
        }

        const result = searchEmptyFrame(this, frameFrom, frameTo);
        return result;
    };

    Task.prototype.annotations.save.implementation = async function (onUpdate) {
        const result = await saveAnnotations(this, onUpdate);
        return result;
    };

    Task.prototype.annotations.merge.implementation = async function (objectStates) {
        const result = await mergeAnnotations(this, objectStates);
        return result;
    };

    Task.prototype.annotations.split.implementation = async function (objectState, frame) {
        const result = await splitAnnotations(this, objectState, frame);
        return result;
    };

    Task.prototype.annotations.group.implementation = async function (objectStates, reset) {
        const result = await groupAnnotations(this, objectStates, reset);
        return result;
    };

    Task.prototype.annotations.hasUnsavedChanges.implementation = function () {
        const result = hasUnsavedChanges(this);
        return result;
    };

    Task.prototype.annotations.clear.implementation = async function (reload) {
        const result = await clearAnnotations(this, reload);
        return result;
    };

    Task.prototype.annotations.select.implementation = function (frame, x, y) {
        const result = selectObject(this, frame, x, y);
        return result;
    };

    Task.prototype.annotations.statistics.implementation = function () {
        const result = annotationsStatistics(this);
        return result;
    };

    Task.prototype.annotations.put.implementation = function (objectStates) {
        const result = putAnnotations(this, objectStates);
        return result;
    };

    Task.prototype.annotations.upload.implementation = async function (
        format: string,
        useDefaultLocation: boolean,
        sourceStorage: Storage,
        file: File | string,
        options?: { convMaskToPoly?: boolean },
    ) {
        const result = await importDataset(this, format, useDefaultLocation, sourceStorage, file, options);
        return result;
    };

    Task.prototype.annotations.import.implementation = function (data) {
        const result = importCollection(this, data);
        return result;
    };

    Task.prototype.annotations.export.implementation = function () {
        const result = exportCollection(this);
        return result;
    };

    Task.prototype.annotations.exportDataset.implementation = async function (
        format: string,
        saveImages: boolean,
        useDefaultSettings: boolean,
        targetStorage: Storage,
        customName?: string,
    ) {
        const result = await exportDataset(this, format, saveImages, useDefaultSettings, targetStorage, customName);
        return result;
    };

    Task.prototype.actions.undo.implementation = function (count) {
        const result = undoActions(this, count);
        return result;
    };

    Task.prototype.actions.redo.implementation = function (count) {
        const result = redoActions(this, count);
        return result;
    };

    Task.prototype.actions.freeze.implementation = function (frozen) {
        const result = freezeHistory(this, frozen);
        return result;
    };

    Task.prototype.actions.clear.implementation = function () {
        const result = clearActions(this);
        return result;
    };

    Task.prototype.actions.get.implementation = function () {
        const result = getActions(this);
        return result;
    };

    Task.prototype.logger.log.implementation = async function (logType, payload, wait) {
        const result = await loggerStorage.log(logType, { ...payload, task_id: this.id }, wait);
        return result;
    };

    Task.prototype.predictor.status.implementation = async function () {
        if (!Number.isInteger(this.projectId)) {
            throw new DataError('The task must belong to a project to use the feature');
        }

        const result = await serverProxy.predictor.status(this.projectId);
        return {
            message: result.message,
            progress: result.progress,
            projectScore: result.score,
            timeRemaining: result.time_remaining,
            mediaAmount: result.media_amount,
            annotationAmount: result.annotation_amount,
        };
    };

    Task.prototype.predictor.predict.implementation = async function (frame) {
        if (!Number.isInteger(frame) || frame < 0) {
            throw new ArgumentError(`Frame must be a positive integer. Got: "${frame}"`);
        }

        if (frame >= this.size) {
            throw new ArgumentError(`The frame with number ${frame} is out of the task`);
        }

        if (!Number.isInteger(this.projectId)) {
            throw new DataError('The task must belong to a project to use the feature');
        }

        const result = await serverProxy.predictor.predict(this.id, frame);
        return result;
    };

    return Task;
}
