// Copyright (C) 2019-2022 Intel Corporation
// Copyright (C) 2022 CVAT.ai Corporation
//
// SPDX-License-Identifier = MIT

export enum ShareFileType {
    DIR = 'DIR',
    REG = 'REG',
}

export enum TaskStatus {
    ANNOTATION = 'annotation',
    VALIDATION = 'validation',
    COMPLETED = 'completed',
}

export enum JobStage {
    ANNOTATION = 'annotation',
    VALIDATION = 'validation',
    ACCEPTANCE = 'acceptance',
}

export enum JobState {
    NEW = 'new',
    IN_PROGRESS = 'in progress',
    COMPLETED = 'completed',
    REJECTED = 'rejected',
}

export enum DimensionType {
    DIMENSION_2D = '2d',
    DIMENSION_3D = '3d',
}

export enum RQStatus {
    QUEUED = 'queued',
    STARTED = 'started',
    FINISHED = 'finished',
    FAILED = 'failed',
    UNKNOWN = 'unknown',
}

export enum TaskMode {
    ANNOTATION = 'annotation',
    INTERPOLATION = 'interpolation',
}

export enum AttributeType {
    CHECKBOX = 'checkbox',
    RADIO = 'radio',
    SELECT = 'select',
    NUMBER = 'number',
    TEXT = 'text',
}

export enum ObjectType {
    TAG = 'tag',
    SHAPE = 'shape',
    TRACK = 'track',
}

export enum ShapeType {
    RECTANGLE = 'rectangle',
    POLYGON = 'polygon',
    POLYLINE = 'polyline',
    POINTS = 'points',
    ELLIPSE = 'ellipse',
    CUBOID = 'cuboid',
    SKELETON = 'skeleton',
    MASK = 'mask',
}

export enum Source {
    MANUAL = 'manual',
    AUTO = 'auto',
}

export enum LogType {
    loadJob = 'Load job',
    saveJob = 'Save job',
    restoreJob = 'Restore job',
    uploadAnnotations = 'Upload annotations',
    sendUserActivity = 'Send user activity',
    sendException = 'Send exception',
    sendTaskInfo = 'Send task info',

    drawObject = 'Draw object',
    pasteObject = 'Paste object',
    copyObject = 'Copy object',
    propagateObject = 'Propagate object',
    dragObject = 'Drag object',
    resizeObject = 'Resize object',
    deleteObject = 'Delete object',
    lockObject = 'Lock object',
    mergeObjects = 'Merge objects',
    changeAttribute = 'Change attribute',
    changeLabel = 'Change label',

    changeFrame = 'Change frame',
    moveImage = 'Move image',
    zoomImage = 'Zoom image',
    fitImage = 'Fit image',
    rotateImage = 'Rotate image',

    undoAction = 'Undo action',
    redoAction = 'Redo action',

    pressShortcut = 'Press shortcut',
    debugInfo = 'Debug info',
}

export enum HistoryActions {
    CHANGED_LABEL = 'Changed label',
    CHANGED_ATTRIBUTES = 'Changed attributes',
    CHANGED_POINTS = 'Changed points',
    CHANGED_ROTATION = 'Object rotated',
    CHANGED_OUTSIDE = 'Changed outside',
    CHANGED_OCCLUDED = 'Changed occluded',
    CHANGED_ZORDER = 'Changed z-order',
    CHANGED_KEYFRAME = 'Changed keyframe',
    CHANGED_LOCK = 'Changed lock',
    CHANGED_PINNED = 'Changed pinned',
    CHANGED_COLOR = 'Changed color',
    CHANGED_HIDDEN = 'Changed hidden',
    CHANGED_SOURCE = 'Changed source',
    MERGED_OBJECTS = 'Merged objects',
    SPLITTED_TRACK = 'Splitted track',
    GROUPED_OBJECTS = 'Grouped objects',
    CREATED_OBJECTS = 'Created objects',
    REMOVED_OBJECT = 'Removed object',
    REMOVED_FRAME = 'Removed frame',
    RESTORED_FRAME = 'Restored frame',
}

export enum ModelType {
    DETECTOR = 'detector',
    INTERACTOR = 'interactor',
    TRACKER = 'tracker',
}

export const colors = [
    '#33ddff',
    '#fa3253',
    '#34d1b7',
    '#ff007c',
    '#ff6037',
    '#ddff33',
    '#24b353',
    '#b83df5',
    '#66ff66',
    '#32b7fa',
    '#ffcc33',
    '#83e070',
    '#fafa37',
    '#5986b3',
    '#8c78f0',
    '#ff6a4d',
    '#f078f0',
    '#2a7dd1',
    '#b25050',
    '#cc3366',
    '#cc9933',
    '#aaf0d1',
    '#ff00cc',
    '#3df53d',
    '#fa32b7',
    '#fa7dbb',
    '#ff355e',
    '#f59331',
    '#3d3df5',
    '#733380',
];

export enum CloudStorageProviderType {
    AWS_S3_BUCKET = 'AWS_S3_BUCKET',
    AZURE_CONTAINER = 'AZURE_CONTAINER',
    GOOGLE_CLOUD_STORAGE = 'GOOGLE_CLOUD_STORAGE',
}

export enum CloudStorageCredentialsType {
    KEY_SECRET_KEY_PAIR = 'KEY_SECRET_KEY_PAIR',
    ACCOUNT_NAME_TOKEN_PAIR = 'ACCOUNT_NAME_TOKEN_PAIR',
    ANONYMOUS_ACCESS = 'ANONYMOUS_ACCESS',
    KEY_FILE_PATH = 'KEY_FILE_PATH',
}

export enum CloudStorageStatus {
    AVAILABLE = 'AVAILABLE',
    NOT_FOUND = 'NOT_FOUND',
    FORBIDDEN = 'FORBIDDEN',
}

export enum MembershipRole {
    WORKER = 'worker',
    SUPERVISOR = 'supervisor',
    MAINTAINER = 'maintainer',
    OWNER = 'owner',
}

export enum SortingMethod {
    LEXICOGRAPHICAL = 'lexicographical',
    NATURAL = 'natural',
    PREDEFINED = 'predefined',
    RANDOM = 'random',
}

export enum StorageLocation {
    LOCAL = 'local',
    CLOUD_STORAGE = 'cloud_storage',
}

export enum WebhookSourceType {
    ORGANIZATION = 'organization',
    PROJECT = 'project',
}

export enum WebhookContentType {
    JSON = 'application/json',
}

export enum LabelType {
    ANY = 'any',
    RECTANGLE = 'rectangle',
    POLYGON = 'polygon',
    POLYLINE = 'polyline',
    POINTS = 'points',
    ELLIPSE = 'ellipse',
    CUBOID = 'cuboid',
    SKELETON = 'skeleton',
    MASK = 'mask',
    TAG = 'tag',
}
