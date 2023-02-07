// Copyright (C) 2019-2022 Intel Corporation
// Copyright (C) 2022 CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT

import config from './config';
import ObjectState, { SerializedData } from './object-state';
import { checkObjectType, clamp } from './common';
import { DataError, ArgumentError, ScriptingError } from './exceptions';
import { Label } from './labels';
import {
    colors, Source, ShapeType, ObjectType, HistoryActions,
} from './enums';
import AnnotationHistory from './annotations-history';
import {
    checkNumberOfPoints, attrsAsAnObject, checkShapeArea, mask2Rle, rle2Mask,
    computeWrappingBox, findAngleDiff, rotatePoint, validateAttributeValue, truncateMask,
} from './object-utils';

const defaultGroupColor = '#E0E0E0';

function copyShape(state: TrackedShape, data: Partial<TrackedShape> = {}): TrackedShape {
    return {
        rotation: state.rotation,
        zOrder: state.zOrder,
        points: state.points,
        occluded: state.occluded,
        outside: state.outside,
        attributes: {},
        ...data,
    };
}

export interface BasicInjection {
    labels: Record<number, Label>;
    groups: { max: number };
    frameMeta: {
        deleted_frames: Record<number, boolean>;
    };
    history: AnnotationHistory;
    groupColors: Record<number, string>;
    parentID?: number;
    readOnlyFields?: string[];
    nextClientID: () => number;
    getMasksOnFrame: (frame: number) => MaskShape[];
}

type AnnotationInjection = BasicInjection & {
    parentID?: number;
    readOnlyFields?: string[];
};

class Annotation {
    public clientID: number;
    protected taskLabels: Label[];
    protected history: any;
    protected groupColors: Record<number, string>;
    public serverID: number | null;
    protected parentID: number | null;
    public group: number;
    public label: Label;
    public frame: number;
    private _removed: boolean;
    public lock: boolean;
    protected readOnlyFields: string[];
    protected color: string;
    protected source: Source;
    public updated: number;
    public attributes: Record<number, string>;
    protected groupObject: {
        color: string;
        readonly id: number;
    };

    constructor(data, clientID: number, color: string, injection: AnnotationInjection) {
        this.taskLabels = injection.labels;
        this.history = injection.history;
        this.groupColors = injection.groupColors;
        this.clientID = clientID;
        this.serverID = data.id || null;
        this.parentID = injection.parentID || null;
        this.group = data.group;
        this.label = this.taskLabels[data.label_id];
        this.frame = data.frame;
        this._removed = false;
        this.lock = false;
        this.readOnlyFields = injection.readOnlyFields || [];
        this.color = color;
        this.source = data.source;
        this.updated = Date.now();
        this.attributes = data.attributes.reduce((attributeAccumulator, attr) => {
            attributeAccumulator[attr.spec_id] = attr.value;
            return attributeAccumulator;
        }, {});
        this.groupObject = Object.defineProperties(
            {}, {
                color: {
                    get: () => {
                        if (this.group) {
                            return this.groupColors[this.group] || colors[this.group % colors.length];
                        }
                        return defaultGroupColor;
                    },
                    set: (newColor) => {
                        if (this.group && typeof newColor === 'string' && /^#[0-9A-F]{6}$/i.test(newColor)) {
                            this.groupColors[this.group] = newColor;
                            this.updated = Date.now();
                        }
                    },
                },
                id: {
                    get: () => this.group,
                },
            },
        ) as Annotation['groupObject'];

        this.appendDefaultAttributes(this.label);
        injection.groups.max = Math.max(injection.groups.max, this.group);
    }

    protected withContext(frame: number): {
        __internal: {
            save: (data: ObjectState) => ObjectState;
            delete: Annotation['delete'];
        };
    } {
        return {
            __internal: {
                save: (this as any).save.bind(this, frame),
                delete: this.delete.bind(this),
            },
        };
    }

    protected saveLock(lock: boolean, frame: number): void {
        const undoLock = this.lock;
        const redoLock = lock;

        this.history.do(
            HistoryActions.CHANGED_LOCK,
            () => {
                this.lock = undoLock;
                this.updated = Date.now();
            },
            () => {
                this.lock = redoLock;
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );

        this.lock = lock;
    }

    protected saveColor(color: string, frame: number): void {
        const undoColor = this.color;
        const redoColor = color;

        this.history.do(
            HistoryActions.CHANGED_COLOR,
            () => {
                this.color = undoColor;
                this.updated = Date.now();
            },
            () => {
                this.color = redoColor;
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );

        this.color = color;
    }

    protected saveLabel(label: Label, frame: number): void {
        const undoLabel = this.label;
        const redoLabel = label;
        const undoAttributes = { ...this.attributes };
        this.label = label;
        this.attributes = {};
        this.appendDefaultAttributes(label);

        // Try to keep old attributes if name matches and old value is still valid
        for (const attribute of redoLabel.attributes) {
            for (const oldAttribute of undoLabel.attributes) {
                if (
                    attribute.name === oldAttribute.name &&
                    validateAttributeValue(undoAttributes[oldAttribute.id], attribute)
                ) {
                    this.attributes[attribute.id] = undoAttributes[oldAttribute.id];
                }
            }
        }
        const redoAttributes = { ...this.attributes };

        this.history.do(
            HistoryActions.CHANGED_LABEL,
            () => {
                this.label = undoLabel;
                this.attributes = undoAttributes;
                this.updated = Date.now();
            },
            () => {
                this.label = redoLabel;
                this.attributes = redoAttributes;
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );
    }

    protected saveAttributes(attributes: Record<number, string>, frame: number): void {
        const undoAttributes = { ...this.attributes };

        for (const attrID of Object.keys(attributes)) {
            this.attributes[attrID] = attributes[attrID];
        }

        const redoAttributes = { ...this.attributes };

        this.history.do(
            HistoryActions.CHANGED_ATTRIBUTES,
            () => {
                this.attributes = undoAttributes;
                this.updated = Date.now();
            },
            () => {
                this.attributes = redoAttributes;
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );
    }

    protected validateStateBeforeSave(data: ObjectState, updated: ObjectState['updateFlags']): void {
        if (updated.label) {
            checkObjectType('label', data.label, null, Label);
        }

        const labelAttributes = attrsAsAnObject(data.label.attributes);
        if (updated.attributes) {
            for (const attrID of Object.keys(data.attributes)) {
                const value = data.attributes[attrID];
                if (attrID in labelAttributes) {
                    if (!validateAttributeValue(value, labelAttributes[attrID])) {
                        throw new ArgumentError(
                            `Trying to save an attribute attribute with id ${attrID} and invalid value ${value}`,
                        );
                    }
                } else {
                    throw new ArgumentError(
                        `The label of the shape doesn't have the attribute with id ${attrID} and value ${value}`,
                    );
                }
            }
        }

        if (updated.descriptions) {
            if (!Array.isArray(data.descriptions) || data.descriptions.some((desc) => typeof desc !== 'string')) {
                throw new ArgumentError(
                    `Descriptions are expected to be an array of strings but got ${data.descriptions}`,
                );
            }
        }

        if (updated.occluded) {
            checkObjectType('occluded', data.occluded, 'boolean', null);
        }

        if (updated.outside) {
            checkObjectType('outside', data.outside, 'boolean', null);
        }

        if (updated.zOrder) {
            checkObjectType('zOrder', data.zOrder, 'integer', null);
        }

        if (updated.lock) {
            checkObjectType('lock', data.lock, 'boolean', null);
        }

        if (updated.pinned) {
            checkObjectType('pinned', data.pinned, 'boolean', null);
        }

        if (updated.color) {
            checkObjectType('color', data.color, 'string', null);
            if (!/^#[0-9A-F]{6}$/i.test(data.color)) {
                throw new ArgumentError(`Got invalid color value: "${data.color}"`);
            }
        }

        if (updated.hidden) {
            checkObjectType('hidden', data.hidden, 'boolean', null);
        }

        if (updated.keyframe) {
            checkObjectType('keyframe', data.keyframe, 'boolean', null);
            if (Object.keys(this.shapes).length === 1 && data.frame in this.shapes && !data.keyframe) {
                throw new ArgumentError(
                    `Can not remove the latest keyframe of an object "${data.label.name}".` +
                    'Consider removing the object instead',
                );
            }
        }
    }

    public clearServerID(): void {
        this.serverID = undefined;
    }

    public updateServerID(body: any): void {
        this.serverID = body.id;
    }

    protected appendDefaultAttributes(label: Label): void {
        const labelAttributes = label.attributes;
        for (const attribute of labelAttributes) {
            if (!(attribute.id in this.attributes)) {
                this.attributes[attribute.id] = attribute.defaultValue;
            }
        }
    }

    protected updateTimestamp(updated: ObjectState['updateFlags']): void {
        const anyChanges = Object.keys(updated).some((key) => !!updated[key]);
        if (anyChanges) {
            this.updated = Date.now();
        }
    }

    public delete(frame: number, force: boolean): boolean {
        if (!this.lock || force) {
            this.removed = true;
            this.history.do(
                HistoryActions.REMOVED_OBJECT,
                () => {
                    this.removed = false;
                    this.updated = Date.now();
                },
                () => {
                    this.removed = true;
                    this.updated = Date.now();
                },
                [this.clientID],
                frame,
            );
        }

        return this.removed;
    }

    public get removed(): boolean {
        return this._removed;
    }

    public set removed(value: boolean) {
        if (value) {
            this.clearServerID();
        }
        this._removed = value;
    }
}

class Drawn extends Annotation {
    protected frameMeta: AnnotationInjection['frameMeta'];
    protected descriptions: string[];
    public hidden: boolean;
    protected pinned: boolean;
    public shapeType: ShapeType;

    constructor(data, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.frameMeta = injection.frameMeta;
        this.descriptions = data.descriptions || [];
        this.hidden = false;
        this.pinned = true;
        this.shapeType = null;
    }

    protected saveDescriptions(descriptions: string[]): void {
        this.descriptions = [...descriptions];
    }

    protected savePinned(pinned: boolean, frame: number): void {
        const undoPinned = this.pinned;
        const redoPinned = pinned;

        this.history.do(
            HistoryActions.CHANGED_PINNED,
            () => {
                this.pinned = undoPinned;
                this.updated = Date.now();
            },
            () => {
                this.pinned = redoPinned;
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );

        this.pinned = pinned;
    }

    protected saveHidden(hidden: boolean, frame: number): void {
        const undoHidden = this.hidden;
        const redoHidden = hidden;

        this.history.do(
            HistoryActions.CHANGED_HIDDEN,
            () => {
                this.hidden = undoHidden;
                this.updated = Date.now();
            },
            () => {
                this.hidden = redoHidden;
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );

        this.hidden = hidden;
    }

    private fitPoints(points: number[], rotation: number, maxX: number, maxY: number): number[] {
        const { shapeType, parentID } = this;
        checkObjectType('rotation', rotation, 'number', null);
        points.forEach((coordinate) => checkObjectType('coordinate', coordinate, 'number', null));

        if (parentID !== null || shapeType === ShapeType.CUBOID ||
            shapeType === ShapeType.ELLIPSE || !!rotation) {
            // cuboids and rotated bounding boxes cannot be fitted
            return points;
        }

        const fittedPoints = [];

        for (let i = 0; i < points.length - 1; i += 2) {
            const x = points[i];
            const y = points[i + 1];
            const clampedX = clamp(x, 0, maxX);
            const clampedY = clamp(y, 0, maxY);
            fittedPoints.push(clampedX, clampedY);
        }

        return fittedPoints;
    }

    protected validateStateBeforeSave(data: ObjectState, updated: ObjectState['updateFlags'], frame?: number): number[] {
        Annotation.prototype.validateStateBeforeSave.call(this, data, updated);

        let fittedPoints = [];
        if (updated.points && Number.isInteger(frame)) {
            checkObjectType('points', data.points, null, Array);
            checkNumberOfPoints(this.shapeType, data.points);
            // cut points
            const { width, height, filename } = this.frameMeta[frame];
            fittedPoints = this.fitPoints(data.points, data.rotation, width, height);
            let check = true;
            if (filename && filename.slice(filename.length - 3) === 'pcd') {
                check = false;
            }
            if (check) {
                if (!checkShapeArea(this.shapeType, fittedPoints)) {
                    fittedPoints = [];
                }
            }
        }

        return fittedPoints;
    }
}

export interface RawShapeData {
    id?: number;
    clientID?: number;
    label_id: number;
    group: number;
    frame: number;
    source: Source;
    attributes: { spec_id: number; value: string }[];
    elements: {
        id?: number;
        attributes: RawTrackData['attributes'];
        label_id: number;
        occluded: boolean;
        outside: boolean;
        points: number[];
        type: ShapeType;
    }[];
    occluded: boolean;
    outside?: boolean; // only for skeleton elements
    points?: number[];
    rotation: number;
    z_order: number;
    type: ShapeType;
}

export class Shape extends Drawn {
    public points: number[];
    public occluded: boolean;
    public outside: boolean;
    public rotation: number;
    public zOrder: number;

    constructor(data: RawShapeData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.points = data.points;
        this.rotation = data.rotation || 0;
        this.occluded = data.occluded;
        this.outside = data.outside;
        this.zOrder = data.z_order;
    }

    // Method is used to export data to the server
    public toJSON(): RawShapeData {
        const result: RawShapeData = {
            type: this.shapeType,
            clientID: this.clientID,
            occluded: this.occluded,
            z_order: this.zOrder,
            points: this.points.slice(),
            rotation: this.rotation,
            attributes: Object.keys(this.attributes).reduce((attributeAccumulator, attrId) => {
                attributeAccumulator.push({
                    spec_id: +attrId,
                    value: this.attributes[attrId],
                });

                return attributeAccumulator;
            }, []),
            elements: [],
            frame: this.frame,
            label_id: this.label.id,
            group: this.group,
            source: this.source,
        };

        if (this.serverID !== null) {
            result.id = this.serverID;
        }

        if (typeof this.outside !== 'undefined') {
            result.outside = this.outside;
        }

        return result;
    }

    public get(frame): { outside?: boolean } & Omit<Required<SerializedData>, 'keyframe' | 'keyframes' | 'elements' | 'outside'> {
        if (frame !== this.frame) {
            throw new ScriptingError('Received frame is not equal to the frame of the shape');
        }

        const result: ReturnType<Shape['get']> = {
            objectType: ObjectType.SHAPE,
            shapeType: this.shapeType,
            clientID: this.clientID,
            serverID: this.serverID,
            parentID: this.parentID,
            occluded: this.occluded,
            lock: this.lock,
            zOrder: this.zOrder,
            points: this.points.slice(),
            rotation: this.rotation,
            attributes: { ...this.attributes },
            descriptions: [...this.descriptions],
            label: this.label,
            group: this.groupObject,
            color: this.color,
            hidden: this.hidden,
            updated: this.updated,
            pinned: this.pinned,
            frame,
            source: this.source,
            ...this.withContext(frame),
        };

        if (typeof this.outside !== 'undefined') {
            result.outside = this.outside;
        }

        return result;
    }

    protected saveRotation(rotation: number, frame: number): void {
        const undoRotation = this.rotation;
        const redoRotation = rotation;
        const undoSource = this.source;
        const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;

        this.history.do(
            HistoryActions.CHANGED_ROTATION,
            () => {
                this.source = undoSource;
                this.rotation = undoRotation;
                this.updated = Date.now();
            },
            () => {
                this.source = redoSource;
                this.rotation = redoRotation;
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );

        this.source = redoSource;
        this.rotation = redoRotation;
    }

    protected savePoints(points: number[], frame: number): void {
        const undoPoints = this.points;
        const redoPoints = points;
        const undoSource = this.source;
        const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;

        this.history.do(
            HistoryActions.CHANGED_POINTS,
            () => {
                this.points = undoPoints;
                this.source = undoSource;
                this.updated = Date.now();
            },
            () => {
                this.points = redoPoints;
                this.source = redoSource;
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );

        this.source = redoSource;
        this.points = redoPoints;
    }

    protected saveOccluded(occluded: boolean, frame: number): void {
        const undoOccluded = this.occluded;
        const redoOccluded = occluded;
        const undoSource = this.source;
        const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;

        this.history.do(
            HistoryActions.CHANGED_OCCLUDED,
            () => {
                this.occluded = undoOccluded;
                this.source = undoSource;
                this.updated = Date.now();
            },
            () => {
                this.occluded = redoOccluded;
                this.source = redoSource;
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );

        this.source = redoSource;
        this.occluded = redoOccluded;
    }

    protected saveOutside(outside: boolean, frame: number): void {
        const undoOutside = this.outside;
        const redoOutside = outside;
        const undoSource = this.source;
        const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;

        this.history.do(
            HistoryActions.CHANGED_OCCLUDED,
            () => {
                this.outside = undoOutside;
                this.source = undoSource;
                this.updated = Date.now();
            },
            () => {
                this.occluded = redoOutside;
                this.source = redoSource;
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );

        this.source = redoSource;
        this.outside = redoOutside;
    }

    protected saveZOrder(zOrder: number, frame: number): void {
        const undoZOrder = this.zOrder;
        const redoZOrder = zOrder;
        const undoSource = this.source;
        const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;

        this.history.do(
            HistoryActions.CHANGED_ZORDER,
            () => {
                this.zOrder = undoZOrder;
                this.source = undoSource;
                this.updated = Date.now();
            },
            () => {
                this.zOrder = redoZOrder;
                this.source = redoSource;
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );

        this.source = redoSource;
        this.zOrder = redoZOrder;
    }

    public save(frame: number, data: ObjectState): ObjectState {
        if (frame !== this.frame) {
            throw new ScriptingError('Received frame is not equal to the frame of the shape');
        }

        if (this.lock && data.lock) {
            return new ObjectState(this.get(frame));
        }

        const updated = data.updateFlags;
        for (const readOnlyField of this.readOnlyFields) {
            updated[readOnlyField] = false;
        }

        const fittedPoints = this.validateStateBeforeSave(data, updated, frame);
        const { rotation } = data;

        // Now when all fields are validated, we can apply them
        if (updated.label) {
            this.saveLabel(data.label, frame);
        }

        if (updated.attributes) {
            this.saveAttributes(data.attributes, frame);
        }

        if (updated.descriptions) {
            this.saveDescriptions(data.descriptions);
        }

        if (updated.rotation) {
            this.saveRotation(rotation, frame);
        }

        if (updated.points && fittedPoints.length) {
            this.savePoints(fittedPoints, frame);
        }

        if (updated.occluded) {
            this.saveOccluded(data.occluded, frame);
        }

        if (updated.outside) {
            this.saveOutside(data.outside, frame);
        }

        if (updated.zOrder) {
            this.saveZOrder(data.zOrder, frame);
        }

        if (updated.lock) {
            this.saveLock(data.lock, frame);
        }

        if (updated.pinned) {
            this.savePinned(data.pinned, frame);
        }

        if (updated.color) {
            this.saveColor(data.color, frame);
        }

        if (updated.hidden) {
            this.saveHidden(data.hidden, frame);
        }

        this.updateTimestamp(updated);
        updated.reset();

        return new ObjectState(this.get(frame));
    }
}

export interface RawTrackData {
    id?: number;
    clientID?: number;
    label_id: number;
    group: number;
    frame: number;
    source: Source;
    attributes: { spec_id: number; value: string }[];
    shapes: {
        attributes: RawTrackData['attributes'];
        id?: number;
        points?: number[];
        frame: number;
        occluded: boolean;
        outside: boolean;
        rotation: number;
        type: ShapeType;
        z_order: number;
    }[];
    elements?: RawTrackData[];
}

interface TrackedShape {
    serverID?: number;
    occluded: boolean;
    outside: boolean;
    rotation: number;
    zOrder: number;
    points?: number[];
    attributes: Record<number, string>;
}

export interface InterpolatedPosition {
    points: number[];
    rotation: number;
    occluded: boolean;
    outside: boolean;
    zOrder: number;
}

export class Track extends Drawn {
    public shapes: Record<number, TrackedShape>;
    constructor(data: RawTrackData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapes = data.shapes.reduce((shapeAccumulator, value) => {
            shapeAccumulator[value.frame] = {
                serverID: value.id,
                occluded: value.occluded,
                zOrder: value.z_order,
                points: value.points,
                outside: value.outside,
                rotation: value.rotation || 0,
                attributes: value.attributes.reduce((attributeAccumulator, attr) => {
                    attributeAccumulator[attr.spec_id] = attr.value;
                    return attributeAccumulator;
                }, {}),
            };

            return shapeAccumulator;
        }, {});
    }

    // Method is used to export data to the server
    public toJSON(): RawTrackData {
        const labelAttributes = attrsAsAnObject(this.label.attributes);

        const result: RawTrackData = {
            clientID: this.clientID,
            label_id: this.label.id,
            frame: this.frame,
            group: this.group,
            source: this.source,
            elements: [],
            attributes: Object.keys(this.attributes).reduce((attributeAccumulator, attrId) => {
                if (!labelAttributes[attrId].mutable) {
                    attributeAccumulator.push({
                        spec_id: +attrId,
                        value: this.attributes[attrId],
                    });
                }

                return attributeAccumulator;
            }, []),
            shapes: Object.keys(this.shapes).reduce((shapesAccumulator, frame) => {
                shapesAccumulator.push({
                    type: this.shapeType,
                    occluded: this.shapes[frame].occluded,
                    z_order: this.shapes[frame].zOrder,
                    rotation: this.shapes[frame].rotation,
                    outside: this.shapes[frame].outside,
                    attributes: Object.keys(this.shapes[frame].attributes).reduce(
                        (attributeAccumulator, attrId) => {
                            if (labelAttributes[attrId].mutable) {
                                attributeAccumulator.push({
                                    spec_id: +attrId,
                                    value: this.shapes[frame].attributes[attrId],
                                });
                            }

                            return attributeAccumulator;
                        },
                        [],
                    ),
                    id: this.shapes[frame].serverID,
                    frame: +frame,
                });

                if (this.shapes[frame].points) {
                    shapesAccumulator[shapesAccumulator.length - 1].points = [...this.shapes[frame].points];
                }

                return shapesAccumulator;
            }, []),
        };

        if (this.serverID !== null) {
            result.id = this.serverID;
        }

        return result;
    }

    public get(frame: number): Omit<Required<SerializedData>, 'elements'> {
        const {
            prev, next, first, last,
        } = this.boundedKeyframes(frame);

        return {
            ...this.getPosition(frame, prev, next),
            attributes: this.getAttributes(frame),
            descriptions: [...this.descriptions],
            group: this.groupObject,
            objectType: ObjectType.TRACK,
            shapeType: this.shapeType,
            clientID: this.clientID,
            serverID: this.serverID,
            parentID: this.parentID,
            lock: this.lock,
            color: this.color,
            hidden: this.hidden,
            updated: this.updated,
            label: this.label,
            pinned: this.pinned,
            keyframes: {
                prev,
                next,
                first,
                last,
            },
            frame,
            source: this.source,
            ...this.withContext(frame),
        };
    }

    public boundedKeyframes(targetFrame: number): ObjectState['keyframes'] {
        const frames = Object.keys(this.shapes).map((frame) => +frame);
        let lDiff = Number.MAX_SAFE_INTEGER;
        let rDiff = Number.MAX_SAFE_INTEGER;
        let first = Number.MAX_SAFE_INTEGER;
        let last = Number.MIN_SAFE_INTEGER;

        for (const frame of frames) {
            if (frame in this.frameMeta.deleted_frames) {
                continue;
            }

            if (frame < first) {
                first = frame;
            }
            if (frame > last) {
                last = frame;
            }

            const diff = Math.abs(targetFrame - frame);

            if (frame < targetFrame && diff < lDiff) {
                lDiff = diff;
            } else if (frame > targetFrame && diff < rDiff) {
                rDiff = diff;
            }
        }

        const prev = lDiff === Number.MAX_SAFE_INTEGER ? null : targetFrame - lDiff;
        const next = rDiff === Number.MAX_SAFE_INTEGER ? null : targetFrame + rDiff;

        return {
            prev,
            next,
            first,
            last,
        };
    }

    protected getAttributes(targetFrame: number): Record<number, string> {
        const result = {};

        // First of all copy all unmutable attributes
        for (const attrID in this.attributes) {
            if (Object.prototype.hasOwnProperty.call(this.attributes, attrID)) {
                result[attrID] = this.attributes[attrID];
            }
        }

        // Secondly get latest mutable attributes up to target frame
        const frames = Object.keys(this.shapes).sort((a, b) => +a - +b);
        for (const frame of frames) {
            if (+frame <= targetFrame) {
                const { attributes } = this.shapes[frame];

                for (const attrID in attributes) {
                    if (Object.prototype.hasOwnProperty.call(attributes, attrID)) {
                        result[attrID] = attributes[attrID];
                    }
                }
            }
        }

        return result;
    }

    public updateServerID(body: RawTrackData): void {
        this.serverID = body.id;
        for (const shape of body.shapes) {
            this.shapes[shape.frame].serverID = shape.id;
        }
    }

    public clearServerID(): void {
        Drawn.prototype.clearServerID.call(this);
        for (const keyframe of Object.keys(this.shapes)) {
            this.shapes[keyframe].serverID = undefined;
        }
    }

    protected saveLabel(label: Label, frame: number): void {
        const undoLabel = this.label;
        const redoLabel = label;
        const undoAttributes = {
            unmutable: { ...this.attributes },
            mutable: Object.keys(this.shapes).map((key) => ({
                frame: +key,
                attributes: { ...this.shapes[key].attributes },
            })),
        };

        this.label = label;
        this.attributes = {};
        for (const shape of Object.values(this.shapes)) {
            shape.attributes = {};
        }
        this.appendDefaultAttributes(label);

        const redoAttributes = {
            unmutable: { ...this.attributes },
            mutable: Object.keys(this.shapes).map((key) => ({
                frame: +key,
                attributes: { ...this.shapes[key].attributes },
            })),
        };

        this.history.do(
            HistoryActions.CHANGED_LABEL,
            () => {
                this.label = undoLabel;
                this.attributes = undoAttributes.unmutable;
                for (const mutable of undoAttributes.mutable) {
                    this.shapes[mutable.frame].attributes = mutable.attributes;
                }
                this.updated = Date.now();
            },
            () => {
                this.label = redoLabel;
                this.attributes = redoAttributes.unmutable;
                for (const mutable of redoAttributes.mutable) {
                    this.shapes[mutable.frame].attributes = mutable.attributes;
                }
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );
    }

    protected saveAttributes(attributes: Record<number, string>, frame: number): void {
        const current = this.get(frame);
        const labelAttributes = attrsAsAnObject(this.label.attributes);

        const wasKeyframe = frame in this.shapes;
        const undoAttributes = this.attributes;
        const undoShape = wasKeyframe ? this.shapes[frame] : undefined;

        let mutableAttributesUpdated = false;
        const redoAttributes = { ...this.attributes };
        for (const attrID of Object.keys(attributes)) {
            if (!labelAttributes[attrID].mutable) {
                redoAttributes[attrID] = attributes[attrID];
            } else if (attributes[attrID] !== current.attributes[attrID]) {
                mutableAttributesUpdated = mutableAttributesUpdated ||
                    // not keyframe yet
                    !(frame in this.shapes) ||
                    // keyframe, but without this attrID
                    !(attrID in this.shapes[frame].attributes) ||
                    // keyframe with attrID, but with another value
                    this.shapes[frame].attributes[attrID] !== attributes[attrID];
            }
        }
        let redoShape;
        if (mutableAttributesUpdated) {
            if (wasKeyframe) {
                redoShape = {
                    ...this.shapes[frame],
                    attributes: {
                        ...this.shapes[frame].attributes,
                    },
                };
            } else {
                redoShape = {
                    frame,
                    zOrder: current.zOrder,
                    points: current.points,
                    outside: current.outside,
                    occluded: current.occluded,
                    attributes: {},
                };
            }
        }

        for (const attrID of Object.keys(attributes)) {
            if (labelAttributes[attrID].mutable && attributes[attrID] !== current.attributes[attrID]) {
                redoShape.attributes[attrID] = attributes[attrID];
            }
        }

        this.attributes = redoAttributes;
        if (redoShape) {
            this.shapes[frame] = redoShape;
        }

        this.history.do(
            HistoryActions.CHANGED_ATTRIBUTES,
            () => {
                this.attributes = undoAttributes;
                if (undoShape) {
                    this.shapes[frame] = undoShape;
                } else if (redoShape) {
                    delete this.shapes[frame];
                }
                this.updated = Date.now();
            },
            () => {
                this.attributes = redoAttributes;
                if (redoShape) {
                    this.shapes[frame] = redoShape;
                }
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );
    }

    protected appendShapeActionToHistory(actionType, frame, undoShape, redoShape, undoSource, redoSource): void {
        this.history.do(
            actionType,
            () => {
                if (!undoShape) {
                    delete this.shapes[frame];
                } else {
                    this.shapes[frame] = undoShape;
                }
                this.source = undoSource;
                this.updated = Date.now();
            },
            () => {
                if (!redoShape) {
                    delete this.shapes[frame];
                } else {
                    this.shapes[frame] = redoShape;
                }
                this.source = redoSource;
                this.updated = Date.now();
            },
            [this.clientID],
            frame,
        );
    }

    protected saveRotation(rotation: number, frame: number): void {
        const wasKeyframe = frame in this.shapes;
        const undoSource = this.source;
        const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;
        const undoShape = wasKeyframe ? this.shapes[frame] : undefined;
        const redoShape = wasKeyframe ?
            { ...this.shapes[frame], rotation } : copyShape(this.get(frame), { rotation });

        this.shapes[frame] = redoShape;
        this.source = redoSource;
        this.appendShapeActionToHistory(
            HistoryActions.CHANGED_ROTATION,
            frame,
            undoShape,
            redoShape,
            undoSource,
            redoSource,
        );
    }

    protected savePoints(points: number[], frame: number): void {
        const wasKeyframe = frame in this.shapes;
        const undoSource = this.source;
        const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;
        const undoShape = wasKeyframe ? this.shapes[frame] : undefined;
        const redoShape = wasKeyframe ?
            { ...this.shapes[frame], points } : copyShape(this.get(frame), { points });

        this.shapes[frame] = redoShape;
        this.source = redoSource;
        this.appendShapeActionToHistory(
            HistoryActions.CHANGED_POINTS,
            frame,
            undoShape,
            redoShape,
            undoSource,
            redoSource,
        );
    }

    protected saveOutside(frame: number, outside: boolean): void {
        const wasKeyframe = frame in this.shapes;
        const undoSource = this.source;
        const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;
        const undoShape = wasKeyframe ? this.shapes[frame] : undefined;
        const redoShape = wasKeyframe ?
            { ...this.shapes[frame], outside } :
            copyShape(this.get(frame), { outside });

        this.shapes[frame] = redoShape;
        this.source = redoSource;
        this.appendShapeActionToHistory(
            HistoryActions.CHANGED_OUTSIDE,
            frame,
            undoShape,
            redoShape,
            undoSource,
            redoSource,
        );
    }

    protected saveOccluded(occluded: boolean, frame: number): void {
        const wasKeyframe = frame in this.shapes;
        const undoSource = this.source;
        const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;
        const undoShape = wasKeyframe ? this.shapes[frame] : undefined;
        const redoShape = wasKeyframe ?
            { ...this.shapes[frame], occluded } :
            copyShape(this.get(frame), { occluded });

        this.shapes[frame] = redoShape;
        this.source = redoSource;
        this.appendShapeActionToHistory(
            HistoryActions.CHANGED_OCCLUDED,
            frame,
            undoShape,
            redoShape,
            undoSource,
            redoSource,
        );
    }

    protected saveZOrder(zOrder: number, frame: number): void {
        const wasKeyframe = frame in this.shapes;
        const undoSource = this.source;
        const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;
        const undoShape = wasKeyframe ? this.shapes[frame] : undefined;
        const redoShape = wasKeyframe ?
            { ...this.shapes[frame], zOrder } :
            copyShape(this.get(frame), { zOrder });

        this.shapes[frame] = redoShape;
        this.source = redoSource;
        this.appendShapeActionToHistory(
            HistoryActions.CHANGED_ZORDER,
            frame,
            undoShape,
            redoShape,
            undoSource,
            redoSource,
        );
    }

    protected saveKeyframe(frame: number, keyframe: boolean): void {
        const wasKeyframe = frame in this.shapes;

        if ((keyframe && wasKeyframe) || (!keyframe && !wasKeyframe)) {
            return;
        }

        const undoSource = this.source;
        const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;
        const undoShape = wasKeyframe ? this.shapes[frame] : undefined;
        const redoShape = keyframe ? copyShape(this.get(frame)) : undefined;

        this.source = redoSource;
        if (redoShape) {
            this.shapes[frame] = redoShape;
        } else {
            delete this.shapes[frame];
        }

        this.appendShapeActionToHistory(
            HistoryActions.CHANGED_KEYFRAME,
            frame,
            undoShape,
            redoShape,
            undoSource,
            redoSource,
        );
    }

    public save(frame: number, data: ObjectState): ObjectState {
        if (this.lock && data.lock) {
            return new ObjectState(this.get(frame));
        }

        const updated = data.updateFlags;
        for (const readOnlyField of this.readOnlyFields) {
            updated[readOnlyField] = false;
        }

        const fittedPoints = this.validateStateBeforeSave(data, updated, frame);
        const { rotation } = data;

        if (updated.label) {
            this.saveLabel(data.label, frame);
        }

        if (updated.lock) {
            this.saveLock(data.lock, frame);
        }

        if (updated.pinned) {
            this.savePinned(data.pinned, frame);
        }

        if (updated.color) {
            this.saveColor(data.color, frame);
        }

        if (updated.hidden) {
            this.saveHidden(data.hidden, frame);
        }

        if (updated.points && fittedPoints.length) {
            this.savePoints(fittedPoints, frame);
        }

        if (updated.rotation) {
            this.saveRotation(rotation, frame);
        }

        if (updated.outside) {
            this.saveOutside(frame, data.outside);
        }

        if (updated.occluded) {
            this.saveOccluded(data.occluded, frame);
        }

        if (updated.zOrder) {
            this.saveZOrder(data.zOrder, frame);
        }

        if (updated.attributes) {
            this.saveAttributes(data.attributes, frame);
        }

        if (updated.descriptions) {
            this.saveDescriptions(data.descriptions);
        }

        if (updated.keyframe) {
            this.saveKeyframe(frame, data.keyframe);
        }

        this.updateTimestamp(updated);
        updated.reset();

        return new ObjectState(this.get(frame));
    }

    protected getPosition(
        targetFrame: number, leftKeyframe: number | null, rightFrame: number | null,
    ): InterpolatedPosition & { keyframe: boolean } {
        const leftFrame = targetFrame in this.shapes ? targetFrame : leftKeyframe;
        const rightPosition = Number.isInteger(rightFrame) ? this.shapes[rightFrame] : null;
        const leftPosition = Number.isInteger(leftFrame) ? this.shapes[leftFrame] : null;

        if (leftPosition && rightPosition) {
            return {
                ...(this as any).interpolatePosition(
                    leftPosition,
                    rightPosition,
                    (targetFrame - leftFrame) / (rightFrame - leftFrame),
                ),
                keyframe: targetFrame in this.shapes,
            };
        }

        const singlePosition = leftPosition || rightPosition;
        if (singlePosition) {
            return {
                points: [...singlePosition.points],
                rotation: singlePosition.rotation,
                occluded: singlePosition.occluded,
                zOrder: singlePosition.zOrder,
                keyframe: targetFrame in this.shapes,
                outside: singlePosition === rightPosition ? true : singlePosition.outside,
            };
        }

        throw new DataError(
            'No one left position or right position was found. ' +
                `Interpolation impossible. Client ID: ${this.clientID}`,
        );
    }
}

export interface RawTagData {
    id?: number;
    clientID?: number;
    label_id: number;
    frame: number;
    group: number;
    source: Source;
    attributes: { spec_id: number; value: string }[];
}

export class Tag extends Annotation {
    // Method is used to export data to the server
    public toJSON(): RawTagData {
        const result: RawTagData = {
            clientID: this.clientID,
            frame: this.frame,
            label_id: this.label.id,
            source: this.source,
            group: 0, // TODO: why server requires group for tags?
            attributes: Object.keys(this.attributes).reduce((attributeAccumulator, attrId) => {
                attributeAccumulator.push({
                    spec_id: +attrId,
                    value: this.attributes[attrId],
                });

                return attributeAccumulator;
            }, []),
        };

        if (this.serverID !== null) {
            result.id = this.serverID;
        }

        return result;
    }

    public get(frame: number): Omit<Required<SerializedData>,
    'elements' | 'occluded' | 'outside' | 'rotation' | 'zOrder' |
    'points' | 'hidden' | 'pinned' | 'keyframe' | 'shapeType' |
    'parentID' | 'descriptions' | 'keyframes'
    > {
        if (frame !== this.frame) {
            throw new ScriptingError('Received frame is not equal to the frame of the shape');
        }

        return {
            objectType: ObjectType.TAG,
            clientID: this.clientID,
            serverID: this.serverID,
            lock: this.lock,
            attributes: { ...this.attributes },
            label: this.label,
            group: this.groupObject,
            color: this.color,
            updated: this.updated,
            frame,
            source: this.source,
            ...this.withContext(frame),
        };
    }

    public save(frame: number, data: ObjectState): ObjectState {
        if (frame !== this.frame) {
            throw new ScriptingError('Received frame is not equal to the frame of the tag');
        }

        if (this.lock && data.lock) {
            return new ObjectState(this.get(frame));
        }

        const updated = data.updateFlags;
        for (const readOnlyField of this.readOnlyFields) {
            updated[readOnlyField] = false;
        }

        this.validateStateBeforeSave(data, updated);

        // Now when all fields are validated, we can apply them
        if (updated.label) {
            this.saveLabel(data.label, frame);
        }

        if (updated.attributes) {
            this.saveAttributes(data.attributes, frame);
        }

        if (updated.lock) {
            this.saveLock(data.lock, frame);
        }

        if (updated.color) {
            this.saveColor(data.color, frame);
        }

        this.updateTimestamp(updated);
        updated.reset();

        return new ObjectState(this.get(frame));
    }
}

export class RectangleShape extends Shape {
    constructor(data: RawShapeData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapeType = ShapeType.RECTANGLE;
        this.pinned = false;
        checkNumberOfPoints(this.shapeType, this.points);
    }

    static distance(points: number[], x: number, y: number, angle: number): number {
        const [xtl, ytl, xbr, ybr] = points;
        const cx = xtl + (xbr - xtl) / 2;
        const cy = ytl + (ybr - ytl) / 2;
        const [rotX, rotY] = rotatePoint(x, y, -angle, cx, cy);

        if (!(rotX >= xtl && rotX <= xbr && rotY >= ytl && rotY <= ybr)) {
            // Cursor is outside of a box
            return null;
        }

        // The shortest distance from point to an edge
        return Math.min.apply(null, [rotX - xtl, rotY - ytl, xbr - rotX, ybr - rotY]);
    }
}

export class EllipseShape extends Shape {
    constructor(data: RawShapeData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapeType = ShapeType.ELLIPSE;
        this.pinned = false;
        checkNumberOfPoints(this.shapeType, this.points);
    }

    static distance(points: number[], x: number, y: number, angle: number): number {
        const [cx, cy, rightX, topY] = points;
        const [rx, ry] = [rightX - cx, cy - topY];
        const [rotX, rotY] = rotatePoint(x, y, -angle, cx, cy);
        // https://math.stackexchange.com/questions/76457/check-if-a-point-is-within-an-ellipse
        const pointWithinEllipse = (_x: number, _y: number): boolean => (
            ((_x - cx) ** 2) / rx ** 2) + (((_y - cy) ** 2) / ry ** 2
        ) <= 1;

        if (!pointWithinEllipse(rotX, rotY)) {
            // Cursor is outside of an ellipse
            return null;
        }

        if (Math.abs(x - cx) < Number.EPSILON && Math.abs(y - cy) < Number.EPSILON) {
            // cursor is near to the center, just return minimum of height, width
            return Math.min(rx, ry);
        }

        // ellipse equation is x^2/rx^2 + y^2/ry^2 = 1
        // from this equation:
        // x^2 = ((rx * ry)^2 - (y * rx)^2) / ry^2
        // y^2 = ((rx * ry)^2 - (x * ry)^2) / rx^2

        // we have one point inside the ellipse, let's build two lines (horizontal and vertical) through the point
        // and find their interception with ellipse
        const x2Equation = (_y: number): number => (((rx * ry) ** 2) - ((_y * rx) ** 2)) / (ry ** 2);
        const y2Equation = (_x: number): number => (((rx * ry) ** 2) - ((_x * ry) ** 2)) / (rx ** 2);

        // shift x,y to the ellipse coordinate system to compute equation correctly
        // y axis is inverted
        const [shiftedX, shiftedY] = [x - cx, cy - y];
        const [x1, x2] = [Math.sqrt(x2Equation(shiftedY)), -Math.sqrt(x2Equation(shiftedY))];
        const [y1, y2] = [Math.sqrt(y2Equation(shiftedX)), -Math.sqrt(y2Equation(shiftedX))];

        // found two points on ellipse edge
        const ellipseP1X = shiftedX >= 0 ? x1 : x2; // ellipseP1Y is shiftedY
        const ellipseP2Y = shiftedY >= 0 ? y1 : y2; // ellipseP1X is shiftedX

        // found diffs between two points on edges and target point
        const diff1X = ellipseP1X - shiftedX;
        const diff2Y = ellipseP2Y - shiftedY;

        // return minimum, get absolute value because we need distance, not diff
        return Math.min(Math.abs(diff1X), Math.abs(diff2Y));
    }
}

class PolyShape extends Shape {
    constructor(data: RawShapeData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.rotation = 0; // is not supported
    }
}

export class PolygonShape extends PolyShape {
    constructor(data: RawShapeData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapeType = ShapeType.POLYGON;
        checkNumberOfPoints(this.shapeType, this.points);
    }

    static distance(points: number[], x: number, y: number): number {
        function position(x1, y1, x2, y2): number {
            return (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1);
        }

        let wn = 0;
        const distances = [];

        for (let i = 0, j = points.length - 2; i < points.length - 1; j = i, i += 2) {
            // Current point
            const x1 = points[j];
            const y1 = points[j + 1];

            // Next point
            const x2 = points[i];
            const y2 = points[i + 1];

            // Check if a point is inside a polygon
            // with a winding numbers algorithm
            // https://en.wikipedia.org/wiki/Point_in_polygon#Winding_number_algorithm
            if (y1 <= y) {
                if (y2 > y) {
                    if (position(x1, y1, x2, y2) > 0) {
                        wn++;
                    }
                }
            } else if (y2 <= y) {
                if (position(x1, y1, x2, y2) < 0) {
                    wn--;
                }
            }

            // Find the shortest distance from point to an edge
            // Get an equation of a line in general
            const aCoef = y1 - y2;
            const bCoef = x2 - x1;

            // Vector (aCoef, bCoef) is a perpendicular to line
            // Now find the point where two lines
            // (edge and its perpendicular through the point (x,y)) are cross
            const xCross = x - aCoef;
            const yCross = y - bCoef;

            if ((xCross - x1) * (x2 - xCross) >= 0 && (yCross - y1) * (y2 - yCross) >= 0) {
                // Cross point is on segment between p1(x1,y1) and p2(x2,y2)
                distances.push(Math.sqrt((x - xCross) ** 2 + (y - yCross) ** 2));
            } else {
                distances.push(
                    Math.min(
                        Math.sqrt((x1 - x) ** 2 + (y1 - y) ** 2),
                        Math.sqrt((x2 - x) ** 2 + (y2 - y) ** 2),
                    ),
                );
            }
        }

        if (wn !== 0) {
            return Math.min.apply(null, distances);
        }

        return null;
    }
}

export class PolylineShape extends PolyShape {
    constructor(data: RawShapeData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapeType = ShapeType.POLYLINE;
        checkNumberOfPoints(this.shapeType, this.points);
    }

    static distance(points: number[], x: number, y: number): number {
        const distances = [];
        for (let i = 0; i < points.length - 2; i += 2) {
            // Current point
            const x1 = points[i];
            const y1 = points[i + 1];

            // Next point
            const x2 = points[i + 2];
            const y2 = points[i + 3];

            // Find the shortest distance from point to an edge
            if ((x - x1) * (x2 - x) >= 0 && (y - y1) * (y2 - y) >= 0) {
                // Find the length of a perpendicular
                // https://en.wikipedia.org/wiki/Distance_from_a_point_to_a_line
                distances.push(
                    Math.abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) /
                        Math.sqrt((y2 - y1) ** 2 + (x2 - x1) ** 2),
                );
            } else {
                // The link below works for lines (which have infinite length)
                // There is a case when perpendicular doesn't cross the edge
                // In this case we don't use the computed distance
                // Instead we use just distance to the nearest point
                distances.push(
                    Math.min(
                        Math.sqrt((x1 - x) ** 2 + (y1 - y) ** 2),
                        Math.sqrt((x2 - x) ** 2 + (y2 - y) ** 2),
                    ),
                );
            }
        }

        return Math.min.apply(null, distances);
    }
}

export class PointsShape extends PolyShape {
    constructor(data: RawShapeData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapeType = ShapeType.POINTS;
        checkNumberOfPoints(this.shapeType, this.points);
    }

    static distance(points: number[], x: number, y: number): number {
        const distances = [];
        for (let i = 0; i < points.length; i += 2) {
            const x1 = points[i];
            const y1 = points[i + 1];

            distances.push(Math.sqrt((x1 - x) ** 2 + (y1 - y) ** 2));
        }

        return Math.min.apply(null, distances);
    }
}

interface Point2D {
    x: number;
    y: number;
}

export class CuboidShape extends Shape {
    constructor(data: RawShapeData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.rotation = 0;
        this.shapeType = ShapeType.CUBOID;
        this.pinned = false;
        checkNumberOfPoints(this.shapeType, this.points);
    }

    static makeHull(geoPoints: Point2D[]): Point2D[] {
        // Returns the convex hull, assuming that each points[i] <= points[i + 1].
        function makeHullPresorted(points: Point2D[]): Point2D[] {
            if (points.length <= 1) return points.slice();

            // Andrew's monotone chain algorithm. Positive y coordinates correspond to 'up'
            // as per the mathematical convention, instead of 'down' as per the computer
            // graphics convention. This doesn't affect the correctness of the result.

            const upperHull = [];
            for (let i = 0; i < points.length; i += 1) {
                const p = points[`${i}`];
                while (upperHull.length >= 2) {
                    const q = upperHull[upperHull.length - 1];
                    const r = upperHull[upperHull.length - 2];
                    if ((q.x - r.x) * (p.y - r.y) >= (q.y - r.y) * (p.x - r.x)) upperHull.pop();
                    else break;
                }
                upperHull.push(p);
            }
            upperHull.pop();

            const lowerHull = [];
            for (let i = points.length - 1; i >= 0; i -= 1) {
                const p = points[`${i}`];
                while (lowerHull.length >= 2) {
                    const q = lowerHull[lowerHull.length - 1];
                    const r = lowerHull[lowerHull.length - 2];
                    if ((q.x - r.x) * (p.y - r.y) >= (q.y - r.y) * (p.x - r.x)) lowerHull.pop();
                    else break;
                }
                lowerHull.push(p);
            }
            lowerHull.pop();

            if (
                upperHull.length === 1 &&
                lowerHull.length === 1 &&
                upperHull[0].x === lowerHull[0].x &&
                upperHull[0].y === lowerHull[0].y
            ) return upperHull;
            return upperHull.concat(lowerHull);
        }

        function pointsComparator(a, b): number {
            if (a.x < b.x) return -1;
            if (a.x > b.x) return +1;
            if (a.y < b.y) return -1;
            if (a.y > b.y) return +1;
            return 0;
        }

        const newPoints = geoPoints.slice();
        newPoints.sort(pointsComparator);
        return makeHullPresorted(newPoints);
    }

    static contain(shapePoints, x, y): boolean {
        function isLeft(P0, P1, P2): number {
            return (P1.x - P0.x) * (P2.y - P0.y) - (P2.x - P0.x) * (P1.y - P0.y);
        }

        const points = CuboidShape.makeHull(shapePoints);
        let wn = 0;
        for (let i = 0; i < points.length; i += 1) {
            const p1 = points[`${i}`];
            const p2 = points[i + 1] || points[0];

            if (p1.y <= y) {
                if (p2.y > y) {
                    if (isLeft(p1, p2, { x, y }) > 0) {
                        wn += 1;
                    }
                }
            } else if (p2.y < y) {
                if (isLeft(p1, p2, { x, y }) < 0) {
                    wn -= 1;
                }
            }
        }

        return wn !== 0;
    }

    static distance(actualPoints: number[], x: number, y: number): number {
        const points = [];

        for (let i = 0; i < 16; i += 2) {
            points.push({ x: actualPoints[i], y: actualPoints[i + 1] });
        }

        if (!CuboidShape.contain(points, x, y)) return null;

        let minDistance = Number.MAX_SAFE_INTEGER;
        for (let i = 0; i < points.length; i += 1) {
            const p1 = points[`${i}`];
            const p2 = points[i + 1] || points[0];

            // perpendicular from point to straight length
            const distance = Math.abs((p2.y - p1.y) * x - (p2.x - p1.x) * y + p2.x * p1.y - p2.y * p1.x) /
                Math.sqrt((p2.y - p1.y) ** 2 + (p2.x - p1.x) ** 2);

            // check if perpendicular belongs to the straight segment
            const a = (p1.x - x) ** 2 + (p1.y - y) ** 2;
            const b = (p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2;
            const c = (p2.x - x) ** 2 + (p2.y - y) ** 2;
            if (distance < minDistance && a + b - c >= 0 && c + b - a >= 0) {
                minDistance = distance;
            }
        }
        return minDistance;
    }
}

export class SkeletonShape extends Shape {
    public elements: Shape[];

    constructor(data: RawShapeData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapeType = ShapeType.SKELETON;
        this.pinned = false;
        this.rotation = 0;
        this.occluded = false;
        this.points = undefined;
        this.readOnlyFields = ['points', 'label', 'occluded'];

        /* eslint-disable-next-line @typescript-eslint/no-use-before-define */
        this.elements = data.elements.map((element) => shapeFactory({
            ...element,
            group: this.group,
            z_order: this.zOrder,
            source: this.source,
            rotation: 0,
            frame: data.frame,
            elements: [],
        }, injection.nextClientID(), {
            ...injection,
            parentID: this.clientID,
            readOnlyFields: ['group', 'zOrder', 'source', 'rotation'],
        })) as any as Shape[];
    }

    static distance(points: number[], x: number, y: number): number {
        const distances = [];
        let xtl = Number.MAX_SAFE_INTEGER;
        let ytl = Number.MAX_SAFE_INTEGER;
        let xbr = 0;
        let ybr = 0;

        const MARGIN = 20;
        for (let i = 0; i < points.length; i += 2) {
            const x1 = points[i];
            const y1 = points[i + 1];
            xtl = Math.min(x1, xtl);
            ytl = Math.min(y1, ytl);
            xbr = Math.max(x1, xbr);
            ybr = Math.max(y1, ybr);

            distances.push(Math.sqrt((x1 - x) ** 2 + (y1 - y) ** 2));
        }

        xtl -= MARGIN;
        xbr += MARGIN;
        ytl -= MARGIN;
        ybr += MARGIN;

        if (!(x >= xtl && x <= xbr && y >= ytl && y <= ybr)) {
            // Cursor is outside of a box
            return null;
        }

        // The shortest distance from point to an edge
        return Math.min.apply(null, [x - xtl, y - ytl, xbr - x, ybr - y]);
    }

    // Method is used to export data to the server
    public toJSON(): RawShapeData {
        const elements = this.elements.map((element) => ({
            ...element.toJSON(),
            outside: element.outside,
            points: [...element.points],
            source: this.source,
            group: this.group,
            z_order: this.zOrder,
            rotation: 0,
        }));

        const result: RawShapeData = {
            type: this.shapeType,
            clientID: this.clientID,
            occluded: elements.every((el) => el.occluded),
            outside: elements.every((el) => el.outside),
            z_order: this.zOrder,
            points: this.points,
            rotation: 0,
            attributes: Object.keys(this.attributes).reduce((attributeAccumulator, attrId) => {
                attributeAccumulator.push({
                    spec_id: +attrId,
                    value: this.attributes[attrId],
                });

                return attributeAccumulator;
            }, []),
            elements,
            frame: this.frame,
            label_id: this.label.id,
            group: this.group,
            source: this.source,
        };

        if (this.serverID !== null) {
            result.id = this.serverID;
        }

        return result;
    }

    public get(frame): Omit<Required<SerializedData>, 'parentID' | 'keyframe' | 'keyframes'> {
        if (frame !== this.frame) {
            throw new ScriptingError('Received frame is not equal to the frame of the shape');
        }

        const elements = this.elements.map((element) => ({
            ...element.get(frame),
            source: this.source,
            group: this.groupObject,
            zOrder: this.zOrder,
            rotation: 0,
        }));

        return {
            objectType: ObjectType.SHAPE,
            shapeType: this.shapeType,
            clientID: this.clientID,
            serverID: this.serverID,
            points: this.points,
            zOrder: this.zOrder,
            rotation: 0,
            attributes: { ...this.attributes },
            descriptions: [...this.descriptions],
            elements,
            label: this.label,
            group: this.groupObject,
            color: this.color,
            updated: Math.max(this.updated, ...this.elements.map((element) => element.updated)),
            pinned: this.pinned,
            outside: elements.every((el) => el.outside),
            occluded: elements.every((el) => el.occluded),
            lock: elements.every((el) => el.lock),
            hidden: elements.every((el) => el.hidden),
            frame,
            source: this.source,
            ...this.withContext(frame),
        };
    }

    public updateServerID(body: RawShapeData): void {
        Shape.prototype.updateServerID.call(this, body);
        for (const element of body.elements) {
            const thisElement = this.elements.find((_element: Shape) => _element.label.id === element.label_id);
            thisElement.updateServerID(element);
        }
    }

    public clearServerID(): void {
        Shape.prototype.clearServerID.call(this);
        for (const element of this.elements) {
            element.clearServerID();
        }
    }

    protected saveRotation(rotation, frame): void {
        const undoSkeletonPoints = this.elements.map((element) => element.points);
        const undoSource = this.source;
        const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;

        const bbox = computeWrappingBox(undoSkeletonPoints.flat());
        const [cx, cy] = [bbox.x + bbox.width / 2, bbox.y + bbox.height / 2];
        for (const element of this.elements) {
            const { points } = element;
            const rotatedPoints = [];
            for (let i = 0; i < points.length; i += 2) {
                const [x, y] = [points[i], points[i + 1]];
                rotatedPoints.push(...rotatePoint(x, y, rotation, cx, cy));
            }

            element.points = rotatedPoints;
        }
        this.source = redoSource;

        const redoSkeletonPoints = this.elements.map((element) => element.points);
        this.history.do(
            HistoryActions.CHANGED_ROTATION,
            () => {
                for (let i = 0; i < this.elements.length; i++) {
                    this.elements[i].points = undoSkeletonPoints[i];
                    this.elements[i].updated = Date.now();
                }
                this.source = undoSource;
                this.updated = Date.now();
            },
            () => {
                for (let i = 0; i < this.elements.length; i++) {
                    this.elements[i].points = redoSkeletonPoints[i];
                    this.elements[i].updated = Date.now();
                }
                this.source = redoSource;
                this.updated = Date.now();
            },
            [this.clientID, ...this.elements.map((element) => element.clientID)],
            frame,
        );
    }

    public save(frame: number, data: ObjectState): ObjectState {
        if (this.lock && data.lock) {
            return new ObjectState(this.get(frame));
        }

        const updateElements = (affectedElements, action, property: 'points' | 'occluded' | 'hidden' | 'lock') => {
            const undoSkeletonProperties = this.elements.map((element) => element[property]);
            const undoSource = this.source;
            const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;

            try {
                this.history.freeze(true);
                affectedElements.forEach((element, idx) => {
                    const annotationContext = this.elements[idx];
                    annotationContext.save(frame, element);
                });
            } finally {
                this.history.freeze(false);
            }

            const redoSkeletonProperties = this.elements.map((element) => element[property]);

            this.history.do(
                action,
                () => {
                    for (let i = 0; i < this.elements.length; i++) {
                        this.elements[i][property] = undoSkeletonProperties[i];
                        this.elements[i].updated = Date.now();
                    }
                    this.source = undoSource;
                    this.updated = Date.now();
                },
                () => {
                    for (let i = 0; i < this.elements.length; i++) {
                        this.elements[i][property] = redoSkeletonProperties[i];
                        this.elements[i].updated = Date.now();
                    }
                    this.source = redoSource;
                    this.updated = Date.now();
                },
                [this.clientID, ...affectedElements.map((element) => element.clientID)],
                frame,
            );
        };

        const updatedPoints = data.elements.filter((el) => el.updateFlags.points);
        const updatedOccluded = data.elements.filter((el) => el.updateFlags.occluded);
        const updatedHidden = data.elements.filter((el) => el.updateFlags.hidden);
        const updatedLock = data.elements.filter((el) => el.updateFlags.lock);

        updatedOccluded.forEach((el) => { el.updateFlags.occluded = false; });
        updatedHidden.forEach((el) => { el.updateFlags.hidden = false; });
        updatedLock.forEach((el) => { el.updateFlags.lock = false; });

        if (updatedPoints.length) {
            updateElements(updatedPoints, HistoryActions.CHANGED_POINTS, 'points');
        }

        if (updatedOccluded.length) {
            updatedOccluded.forEach((el) => { el.updateFlags.occluded = true; });
            updateElements(updatedOccluded, HistoryActions.CHANGED_OCCLUDED, 'occluded');
        }

        if (updatedHidden.length) {
            updatedHidden.forEach((el) => { el.updateFlags.hidden = true; });
            updateElements(updatedHidden, HistoryActions.CHANGED_OUTSIDE, 'hidden');
        }

        if (updatedLock.length) {
            updatedLock.forEach((el) => { el.updateFlags.lock = true; });
            updateElements(updatedLock, HistoryActions.CHANGED_LOCK, 'lock');
        }

        const result = Shape.prototype.save.call(this, frame, data);
        return result;
    }

    get occluded(): boolean {
        return this.elements.every((element) => element.occluded);
    }

    set occluded(_) {
        // stub
    }

    get lock(): boolean {
        return this.elements.every((element) => element.lock);
    }

    set lock(_) {
        // stub
    }
}

export class MaskShape extends Shape {
    private left: number;
    private top: number;
    private right: number;
    private bottom: number;
    private getMasksOnFrame: AnnotationInjection['getMasksOnFrame'];

    constructor(data, clientID, color, injection) {
        super(data, clientID, color, injection);
        [this.left, this.top, this.right, this.bottom] = this.points.splice(-4, 4);
        this.getMasksOnFrame = injection.getMasksOnFrame;
        this.pinned = true;
        this.shapeType = ShapeType.MASK;
    }

    protected validateStateBeforeSave(data: ObjectState, updated: ObjectState['updateFlags'], frame?: number): number[] {
        Annotation.prototype.validateStateBeforeSave.call(this, data, updated);
        if (updated.points) {
            const { width, height } = this.frameMeta[frame];
            const fittedPoints = truncateMask(data.points, 0, width, height);
            return fittedPoints;
        }

        return [];
    }

    public removeUnderlyingPixels(frame: number): void {
        if (frame !== this.frame) {
            throw new ArgumentError(
                `Wrong "frame" attribute: is not equal to the shape frame (${frame} vs ${this.frame})`,
            );
        }

        const others = this.getMasksOnFrame(frame)
            .filter((mask: MaskShape) => mask.clientID !== this.clientID && !mask.removed);
        const width = this.right - this.left + 1;
        const height = this.bottom - this.top + 1;
        const updatedObjects: Record<number, MaskShape> = {};

        const masks = {};
        const currentMask = rle2Mask(this.points, width, height);
        for (let i = 0; i < currentMask.length; i++) {
            if (currentMask[i]) {
                const imageX = (i % width) + this.left;
                const imageY = Math.trunc(i / width) + this.top;
                for (const other of others) {
                    const box = {
                        left: other.left,
                        top: other.top,
                        right: other.right,
                        bottom: other.bottom,
                    };
                    const translatedX = imageX - box.left;
                    const translatedY = imageY - box.top;
                    const [otherWidth, otherHeight] = [box.right - box.left + 1, box.bottom - box.top + 1];
                    if (translatedX >= 0 && translatedX < otherWidth &&
                        translatedY >= 0 && translatedY < otherHeight) {
                        masks[other.clientID] = masks[other.clientID] ||
                            rle2Mask(other.points, otherWidth, otherHeight);
                        const j = translatedY * otherWidth + translatedX;
                        masks[other.clientID][j] = 0;
                        updatedObjects[other.clientID] = other;
                    }
                }
            }
        }

        for (const object of Object.values(updatedObjects)) {
            object.points = mask2Rle(masks[object.clientID]);
            object.updated = Date.now();
        }
    }

    protected savePoints(maskPoints: number[], frame: number): void {
        const undoPoints = this.points;
        const undoLeft = this.left;
        const undoRight = this.right;
        const undoTop = this.top;
        const undoBottom = this.bottom;
        const undoSource = this.source;

        const [redoLeft, redoTop, redoRight, redoBottom] = maskPoints.splice(-4);
        const points = mask2Rle(maskPoints);

        const redoPoints = points;
        const redoSource = Source.MANUAL;

        const undo = (): void => {
            this.points = undoPoints;
            this.source = undoSource;
            this.left = undoLeft;
            this.top = undoTop;
            this.right = undoRight;
            this.bottom = undoBottom;
            this.updated = Date.now();
        };

        const redo = (): void => {
            this.points = redoPoints;
            this.source = redoSource;
            this.left = redoLeft;
            this.top = redoTop;
            this.right = redoRight;
            this.bottom = redoBottom;
            this.updated = Date.now();
        };

        this.history.do(
            HistoryActions.CHANGED_POINTS,
            undo, redo, [this.clientID], frame,
        );

        redo();

        if (config.removeUnderlyingMaskPixels) {
            this.removeUnderlyingPixels(frame);
        }
    }

    static distance(points: number[], x: number, y: number): null | number {
        const [left, top, right, bottom] = points.slice(-4);
        const [width, height] = [right - left + 1, bottom - top + 1];
        const [translatedX, translatedY] = [x - left, y - top];
        if (translatedX < 0 || translatedX >= width || translatedY < 0 || translatedY >= height) {
            return null;
        }
        const offset = Math.floor(translatedY) * width + Math.floor(translatedX);

        if (points[offset]) return 1;
        return null;
    }
}

MaskShape.prototype.toJSON = function () {
    const result = Shape.prototype.toJSON.call(this);
    result.points = this.points.slice();
    result.points.push(this.left, this.top, this.right, this.bottom);
    return result;
};

MaskShape.prototype.get = function (frame) {
    const result = Shape.prototype.get.call(this, frame);
    result.points = rle2Mask(this.points, this.right - this.left + 1, this.bottom - this.top + 1);
    result.points.push(this.left, this.top, this.right, this.bottom);
    return result;
};

export class RectangleTrack extends Track {
    constructor(data: RawTrackData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapeType = ShapeType.RECTANGLE;
        this.pinned = false;
        for (const shape of Object.values(this.shapes)) {
            checkNumberOfPoints(this.shapeType, shape.points);
        }
    }

    protected interpolatePosition(leftPosition, rightPosition, offset): InterpolatedPosition {
        const positionOffset = leftPosition.points.map((point, index) => rightPosition.points[index] - point);
        return {
            points: leftPosition.points.map((point, index) => point + positionOffset[index] * offset),
            rotation:
                (leftPosition.rotation + findAngleDiff(
                    rightPosition.rotation, leftPosition.rotation,
                ) * offset + 360) % 360,
            occluded: leftPosition.occluded,
            outside: leftPosition.outside,
            zOrder: leftPosition.zOrder,
        };
    }
}

export class EllipseTrack extends Track {
    constructor(data: RawTrackData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapeType = ShapeType.ELLIPSE;
        this.pinned = false;
        for (const shape of Object.values(this.shapes)) {
            checkNumberOfPoints(this.shapeType, shape.points);
        }
    }

    interpolatePosition(leftPosition, rightPosition, offset): InterpolatedPosition {
        const positionOffset = leftPosition.points.map((point, index) => rightPosition.points[index] - point);

        return {
            points: leftPosition.points.map((point, index) => point + positionOffset[index] * offset),
            rotation:
                (leftPosition.rotation + findAngleDiff(
                    rightPosition.rotation, leftPosition.rotation,
                ) * offset + 360) % 360,
            occluded: leftPosition.occluded,
            outside: leftPosition.outside,
            zOrder: leftPosition.zOrder,
        };
    }
}

class PolyTrack extends Track {
    constructor(data: RawTrackData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        for (const shape of Object.values(this.shapes)) {
            shape.rotation = 0; // is not supported
        }
    }

    protected interpolatePosition(leftPosition, rightPosition, offset): InterpolatedPosition {
        if (offset === 0) {
            return {
                points: [...leftPosition.points],
                rotation: leftPosition.rotation,
                occluded: leftPosition.occluded,
                outside: leftPosition.outside,
                zOrder: leftPosition.zOrder,
            };
        }

        function toArray(points: { x: number; y: number; }[]): number[] {
            return points.reduce((acc, val) => {
                acc.push(val.x, val.y);
                return acc;
            }, []);
        }

        function toPoints(array: number[]): { x: number; y: number; }[] {
            return array.reduce((acc, _, index) => {
                if (index % 2) {
                    acc.push({
                        x: array[index - 1],
                        y: array[index],
                    });
                }

                return acc;
            }, []);
        }

        function curveLength(points: { x: number; y: number; }[]): number {
            return points.slice(1).reduce((acc, _, index) => {
                const dx = points[index + 1].x - points[index].x;
                const dy = points[index + 1].y - points[index].y;
                return acc + Math.sqrt(dx ** 2 + dy ** 2);
            }, 0);
        }

        function curveToOffsetVec(points: { x: number; y: number; }[], length: number): number[] {
            const offsetVector = [0]; // with initial value
            let accumulatedLength = 0;

            points.slice(1).forEach((_, index) => {
                const dx = points[index + 1].x - points[index].x;
                const dy = points[index + 1].y - points[index].y;
                accumulatedLength += Math.sqrt(dx ** 2 + dy ** 2);
                offsetVector.push(accumulatedLength / length);
            });

            return offsetVector;
        }

        function findNearestPair(value: number, curve: number[]): number {
            let minimum = [0, Math.abs(value - curve[0])];
            for (let i = 1; i < curve.length; i++) {
                const distance = Math.abs(value - curve[i]);
                if (distance < minimum[1]) {
                    minimum = [i, distance];
                }
            }

            return minimum[0];
        }

        function matchLeftRight(leftCurve: number[], rightCurve: number[]): Record<number, [number, number[]]> {
            const matching = {};
            for (let i = 0; i < leftCurve.length; i++) {
                matching[i] = [findNearestPair(leftCurve[i], rightCurve)];
            }

            return matching;
        }

        function matchRightLeft(
            leftCurve: number[],
            rightCurve: number[],
            leftRightMatching: Record<number, [number, number[]]>,
        ): Record<number, [number, number[]]> {
            const matchedRightPoints = Object.values(leftRightMatching).flat();
            const unmatchedRightPoints = rightCurve
                .map((_, index) => index)
                .filter((index) => !matchedRightPoints.includes(index));
            const updatedMatching = { ...leftRightMatching };

            for (const rightPoint of unmatchedRightPoints) {
                const leftPoint = findNearestPair(rightCurve[rightPoint], leftCurve);
                updatedMatching[leftPoint].push(rightPoint);
            }

            for (const key of Object.keys(updatedMatching)) {
                const sortedRightIndexes = updatedMatching[key].sort((a, b) => a - b);
                updatedMatching[key] = sortedRightIndexes;
            }

            return updatedMatching;
        }

        function reduceInterpolation(interpolatedPoints, matching, leftPoints, rightPoints) {
            function averagePoint(points: Point2D[]): Point2D {
                let sumX = 0;
                let sumY = 0;
                for (const point of points) {
                    sumX += point.x;
                    sumY += point.y;
                }

                return {
                    x: sumX / points.length,
                    y: sumY / points.length,
                };
            }

            function computeDistance(point1: Point2D, point2: Point2D): number {
                return Math.sqrt((point1.x - point2.x) ** 2 + (point1.y - point2.y) ** 2);
            }

            function minimizeSegment(baseLength: number, N: number, startInterpolated, stopInterpolated) {
                const threshold = baseLength / (2 * N);
                const minimized = [interpolatedPoints[startInterpolated]];
                let latestPushed = startInterpolated;
                for (let i = startInterpolated + 1; i < stopInterpolated; i++) {
                    const distance = computeDistance(interpolatedPoints[latestPushed], interpolatedPoints[i]);

                    if (distance >= threshold) {
                        minimized.push(interpolatedPoints[i]);
                        latestPushed = i;
                    }
                }

                minimized.push(interpolatedPoints[stopInterpolated]);

                if (minimized.length === 2) {
                    const distance = computeDistance(
                        interpolatedPoints[startInterpolated],
                        interpolatedPoints[stopInterpolated],
                    );

                    if (distance < threshold) {
                        return [averagePoint(minimized)];
                    }
                }

                return minimized;
            }

            const reduced = [];
            const interpolatedIndexes = {};
            let accumulated = 0;
            for (let i = 0; i < leftPoints.length; i++) {
                // eslint-disable-next-line
                interpolatedIndexes[i] = matching[i].map(() => accumulated++);
            }

            function leftSegment(start, stop) {
                const startInterpolated = interpolatedIndexes[start][0];
                const stopInterpolated = interpolatedIndexes[stop][0];

                if (startInterpolated === stopInterpolated) {
                    reduced.push(interpolatedPoints[startInterpolated]);
                    return;
                }

                const baseLength = curveLength(leftPoints.slice(start, stop + 1));
                const N = stop - start + 1;

                reduced.push(...minimizeSegment(baseLength, N, startInterpolated, stopInterpolated));
            }

            function rightSegment(leftPoint) {
                const start = matching[leftPoint][0];
                const [stop] = matching[leftPoint].slice(-1);
                const startInterpolated = interpolatedIndexes[leftPoint][0];
                const [stopInterpolated] = interpolatedIndexes[leftPoint].slice(-1);
                const baseLength = curveLength(rightPoints.slice(start, stop + 1));
                const N = stop - start + 1;

                reduced.push(...minimizeSegment(baseLength, N, startInterpolated, stopInterpolated));
            }

            let previousOpened = null;
            for (let i = 0; i < leftPoints.length; i++) {
                if (matching[i].length === 1) {
                    // check if left segment is opened
                    if (previousOpened !== null) {
                        // check if we should continue the left segment
                        if (matching[i][0] === matching[previousOpened][0]) {
                            continue;
                        } else {
                            // left segment found
                            const start = previousOpened;
                            const stop = i - 1;
                            leftSegment(start, stop);

                            // start next left segment
                            previousOpened = i;
                        }
                    } else {
                        // start next left segment
                        previousOpened = i;
                    }
                } else {
                    // check if left segment is opened
                    if (previousOpened !== null) {
                        // left segment found
                        const start = previousOpened;
                        const stop = i - 1;
                        leftSegment(start, stop);

                        previousOpened = null;
                    }

                    // right segment found
                    rightSegment(i);
                }
            }

            // check if there is an opened segment
            if (previousOpened !== null) {
                leftSegment(previousOpened, leftPoints.length - 1);
            }

            return reduced;
        }

        // the algorithm below is based on fact that both left and right
        // polyshapes have the same start point and the same draw direction
        const leftPoints = toPoints(leftPosition.points);
        const rightPoints = toPoints(rightPosition.points);
        const leftOffsetVec = curveToOffsetVec(leftPoints, curveLength(leftPoints));
        const rightOffsetVec = curveToOffsetVec(rightPoints, curveLength(rightPoints));

        const matching = matchLeftRight(leftOffsetVec, rightOffsetVec);
        const completedMatching = matchRightLeft(leftOffsetVec, rightOffsetVec, matching);

        const interpolatedPoints = Object.keys(completedMatching)
            .map((leftPointIdx) => +leftPointIdx)
            .sort((a, b) => a - b)
            .reduce((acc, leftPointIdx) => {
                const leftPoint = leftPoints[leftPointIdx];
                for (const rightPointIdx of completedMatching[leftPointIdx]) {
                    const rightPoint = rightPoints[rightPointIdx];
                    acc.push({
                        x: leftPoint.x + (rightPoint.x - leftPoint.x) * offset,
                        y: leftPoint.y + (rightPoint.y - leftPoint.y) * offset,
                    });
                }

                return acc;
            }, []);

        const reducedPoints = reduceInterpolation(interpolatedPoints, completedMatching, leftPoints, rightPoints);

        return {
            points: toArray(reducedPoints),
            rotation: leftPosition.rotation,
            occluded: leftPosition.occluded,
            outside: leftPosition.outside,
            zOrder: leftPosition.zOrder,
        };
    }
}

export class PolygonTrack extends PolyTrack {
    constructor(data: RawTrackData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapeType = ShapeType.POLYGON;
        for (const shape of Object.values(this.shapes)) {
            checkNumberOfPoints(this.shapeType, shape.points);
        }
    }

    protected interpolatePosition(leftPosition, rightPosition, offset): InterpolatedPosition {
        const copyLeft = {
            ...leftPosition,
            points: [...leftPosition.points, leftPosition.points[0], leftPosition.points[1]],
        };

        const copyRight = {
            ...rightPosition,
            points: [...rightPosition.points, rightPosition.points[0], rightPosition.points[1]],
        };

        const result = PolyTrack.prototype.interpolatePosition.call(this, copyLeft, copyRight, offset);

        return {
            ...result,
            points: result.points.slice(0, -2),
        };
    }
}

export class PolylineTrack extends PolyTrack {
    constructor(data: RawTrackData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapeType = ShapeType.POLYLINE;
        for (const shape of Object.values(this.shapes)) {
            checkNumberOfPoints(this.shapeType, shape.points);
        }
    }
}

export class PointsTrack extends PolyTrack {
    constructor(data: RawTrackData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapeType = ShapeType.POINTS;
        for (const shape of Object.values(this.shapes)) {
            checkNumberOfPoints(this.shapeType, shape.points);
        }
    }

    protected interpolatePosition(leftPosition, rightPosition, offset): InterpolatedPosition {
        // interpolate only when one point in both left and right positions
        if (leftPosition.points.length === 2 && rightPosition.points.length === 2) {
            return {
                points: leftPosition.points.map(
                    (value, index) => value + (rightPosition.points[index] - value) * offset,
                ),
                rotation: leftPosition.rotation,
                occluded: leftPosition.occluded,
                outside: leftPosition.outside,
                zOrder: leftPosition.zOrder,
            };
        }

        return {
            points: [...leftPosition.points],
            rotation: leftPosition.rotation,
            occluded: leftPosition.occluded,
            outside: leftPosition.outside,
            zOrder: leftPosition.zOrder,
        };
    }
}

export class CuboidTrack extends Track {
    constructor(data: RawTrackData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapeType = ShapeType.CUBOID;
        this.pinned = false;
        for (const shape of Object.values(this.shapes)) {
            checkNumberOfPoints(this.shapeType, shape.points);
            shape.rotation = 0; // is not supported
        }
    }

    protected interpolatePosition(leftPosition, rightPosition, offset): InterpolatedPosition {
        const positionOffset = leftPosition.points.map((point, index) => rightPosition.points[index] - point);

        return {
            points: leftPosition.points.map((point, index) => point + positionOffset[index] * offset),
            rotation: leftPosition.rotation,
            occluded: leftPosition.occluded,
            outside: leftPosition.outside,
            zOrder: leftPosition.zOrder,
        };
    }
}

export class SkeletonTrack extends Track {
    public elements: Track[];

    constructor(data: RawTrackData, clientID: number, color: string, injection: AnnotationInjection) {
        super(data, clientID, color, injection);
        this.shapeType = ShapeType.SKELETON;

        for (const shape of Object.values(this.shapes)) {
            delete shape.points;
        }

        this.readOnlyFields = ['points', 'label', 'occluded', 'outside'];
        this.pinned = false;
        this.elements = data.elements.map((element: RawTrackData['elements'][0]) => (
            /* eslint-disable-next-line @typescript-eslint/no-use-before-define */
            trackFactory({
                ...element,
                group: this.group,
                source: this.source,
            }, injection.nextClientID(), {
                ...injection,
                parentID: this.clientID,
                readOnlyFields: ['group', 'zOrder', 'source', 'rotation'],
            })

            // todo z_order: this.zOrder,
        )).sort((a: Annotation, b: Annotation) => a.label.id - b.label.id) as any as Track[];
    }

    public updateServerID(body: RawTrackData): void {
        Track.prototype.updateServerID.call(this, body);
        for (const element of body.elements) {
            const thisElement = this.elements.find((_element: Track) => _element.label.id === element.label_id);
            thisElement.updateServerID(element);
        }
    }

    public clearServerID(): void {
        Track.prototype.clearServerID.call(this);
        for (const element of this.elements) {
            element.clearServerID();
        }
    }

    protected saveRotation(rotation: number, frame: number): void {
        const undoSkeletonShapes = this.elements.map((element) => element.shapes[frame]);
        const undoSource = this.source;
        const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;

        const elementsData = this.elements.map((element) => element.get(frame));
        const skeletonPoints = elementsData.map((data) => data.points);
        const bbox = computeWrappingBox(skeletonPoints.flat());
        const [cx, cy] = [bbox.x + bbox.width / 2, bbox.y + bbox.height / 2];

        for (let i = 0; i < this.elements.length; i++) {
            const element = this.elements[i];
            const { points } = elementsData[i];

            const rotatedPoints = [];
            for (let j = 0; j < points.length; j += 2) {
                const [x, y] = [points[j], points[j + 1]];
                rotatedPoints.push(...rotatePoint(x, y, rotation, cx, cy));
            }

            if (undoSkeletonShapes[i]) {
                element.shapes[frame] = {
                    ...undoSkeletonShapes[i],
                    points: rotatedPoints,
                };
            } else {
                element.shapes[frame] = {
                    ...copyShape(elementsData[i]),
                    points: rotatedPoints,
                };
            }
        }
        this.source = redoSource;

        const redoSkeletonShapes = this.elements.map((element) => element.shapes[frame]);
        this.history.do(
            HistoryActions.CHANGED_ROTATION,
            () => {
                for (let i = 0; i < this.elements.length; i++) {
                    const element = this.elements[i];
                    if (undoSkeletonShapes[i]) {
                        element.shapes[frame] = undoSkeletonShapes[i];
                    } else {
                        delete element.shapes[frame];
                    }
                    this.updated = Date.now();
                }
                this.source = undoSource;
                this.updated = Date.now();
            },
            () => {
                for (let i = 0; i < this.elements.length; i++) {
                    const element = this.elements[i];
                    element.shapes[frame] = redoSkeletonShapes[i];
                    this.updated = Date.now();
                }
                this.source = redoSource;
                this.updated = Date.now();
            },
            [this.clientID, ...this.elements.map((element) => element.clientID)],
            frame,
        );
    }

    // Method is used to export data to the server
    public toJSON(): RawTrackData {
        const result: RawTrackData = Track.prototype.toJSON.call(this);
        result.elements = this.elements.map((el) => el.toJSON());
        return result;
    }

    public get(frame: number): Omit<Required<SerializedData>, 'parentID'> {
        const { prev, next } = this.boundedKeyframes(frame);
        const position = this.getPosition(frame, prev, next);
        const elements = this.elements.map((element) => ({
            ...element.get(frame),
            source: this.source,
            group: this.groupObject,
            zOrder: position.zOrder,
            rotation: 0,
        }));

        return {
            ...position,
            keyframe: position.keyframe || elements.some((el) => el.keyframe),
            attributes: this.getAttributes(frame),
            descriptions: [...this.descriptions],
            group: this.groupObject,
            objectType: ObjectType.TRACK,
            shapeType: this.shapeType,
            clientID: this.clientID,
            serverID: this.serverID,
            color: this.color,
            updated: Math.max(this.updated, ...this.elements.map((element) => element.updated)),
            label: this.label,
            pinned: this.pinned,
            keyframes: this.deepBoundedKeyframes(frame),
            elements,
            frame,
            source: this.source,
            outside: elements.every((el) => el.outside),
            occluded: elements.every((el) => el.occluded),
            lock: elements.every((el) => el.lock),
            hidden: elements.every((el) => el.hidden),
            ...this.withContext(frame),
        };
    }

    // finds keyframes considering keyframes of nested elements
    private deepBoundedKeyframes(targetFrame: number): ObjectState['keyframes'] {
        const boundedKeyframes = Track.prototype.boundedKeyframes.call(this, targetFrame);

        for (const element of this.elements) {
            const keyframes = element.boundedKeyframes(targetFrame);
            if (keyframes.prev !== null) {
                boundedKeyframes.prev = boundedKeyframes.prev === null || keyframes.prev > boundedKeyframes.prev ?
                    keyframes.prev : boundedKeyframes.prev;
            }

            if (keyframes.next !== null) {
                boundedKeyframes.next = boundedKeyframes.next === null || keyframes.next < boundedKeyframes.next ?
                    keyframes.next : boundedKeyframes.next;
            }

            if (keyframes.first !== null) {
                boundedKeyframes.first =
                    boundedKeyframes.first === null || keyframes.first < boundedKeyframes.first ?
                        keyframes.first : boundedKeyframes.first;
            }

            if (keyframes.last !== null) {
                boundedKeyframes.last = boundedKeyframes.last === null || keyframes.last > boundedKeyframes.last ?
                    keyframes.last : boundedKeyframes.last;
            }
        }

        return boundedKeyframes;
    }

    public save(frame: number, data: ObjectState): ObjectState {
        if (this.lock && data.lock) {
            return new ObjectState(this.get(frame));
        }

        const updateElements = (affectedElements, action, property: 'hidden' | 'lock' | null = null): void => {
            const undoSkeletonProperties = this.elements.map((element) => element[property] || null);
            const undoSkeletonShapes = this.elements.map((element) => element.shapes[frame]);
            const undoSource = this.source;
            const redoSource = this.readOnlyFields.includes('source') ? this.source : Source.MANUAL;

            const errors = [];
            try {
                this.history.freeze(true);
                affectedElements.forEach((element, idx) => {
                    try {
                        const annotationContext = this.elements[idx];
                        annotationContext.save(frame, element);
                    } catch (error: any) {
                        errors.push(error);
                    }
                });
            } finally {
                this.history.freeze(false);
            }

            const redoSkeletonProperties = this.elements.map((element) => element[property] || null);
            const redoSkeletonShapes = this.elements.map((element) => element.shapes[frame]);

            this.history.do(
                action,
                () => {
                    for (let i = 0; i < this.elements.length; i++) {
                        if (property) {
                            this.elements[i][property] = undoSkeletonProperties[i];
                        } if (undoSkeletonShapes[i]) {
                            this.elements[i].shapes[frame] = undoSkeletonShapes[i];
                        } else if (redoSkeletonShapes[i]) {
                            delete this.elements[i].shapes[frame];
                        }
                        this.elements[i].updated = Date.now();
                    }
                    this.source = undoSource;
                    this.updated = Date.now();
                },
                () => {
                    for (let i = 0; i < this.elements.length; i++) {
                        if (property) {
                            this.elements[i][property] = redoSkeletonProperties[i];
                        } else if (redoSkeletonShapes[i]) {
                            this.elements[i].shapes[frame] = redoSkeletonShapes[i];
                        } else if (undoSkeletonShapes[i]) {
                            delete this.elements[i].shapes[frame];
                        }
                        this.elements[i].updated = Date.now();
                    }
                    this.source = redoSource;
                    this.updated = Date.now();
                },
                [this.clientID, ...affectedElements.map((element) => element.clientID)],
                frame,
            );

            if (errors.length) {
                throw new Error(`Several errors occurred during saving skeleton:\n ${errors.join(';\n')}`);
            }
        };

        const updatedPoints = data.elements.filter((el) => el.updateFlags.points);
        const updatedOccluded = data.elements.filter((el) => el.updateFlags.occluded);
        const updatedOutside = data.elements.filter((el) => el.updateFlags.outside);
        const updatedKeyframe = data.elements.filter((el) => el.updateFlags.keyframe);
        const updatedHidden = data.elements.filter((el) => el.updateFlags.hidden);
        const updatedLock = data.elements.filter((el) => el.updateFlags.lock);

        updatedOccluded.forEach((el) => { el.updateFlags.occluded = false; });
        updatedOutside.forEach((el) => { el.updateFlags.outside = false; });
        updatedKeyframe.forEach((el) => { el.updateFlags.keyframe = false; });
        updatedHidden.forEach((el) => { el.updateFlags.hidden = false; });
        updatedLock.forEach((el) => { el.updateFlags.lock = false; });

        if (updatedPoints.length) {
            updateElements(updatedPoints, HistoryActions.CHANGED_POINTS);
        }

        if (updatedOccluded.length) {
            updatedOccluded.forEach((el) => { el.updateFlags.occluded = true; });
            updateElements(updatedOccluded, HistoryActions.CHANGED_OCCLUDED);
        }

        if (updatedOutside.length) {
            updatedOutside.forEach((el) => { el.updateFlags.outside = true; });
            updateElements(updatedOutside, HistoryActions.CHANGED_OUTSIDE);
        }

        if (updatedKeyframe.length) {
            updatedKeyframe.forEach((el) => { el.updateFlags.keyframe = true; });
            // todo: fix extra undo/redo change
            this.validateStateBeforeSave(data, data.updateFlags, frame);
            this.saveKeyframe(frame, data.keyframe);
            data.updateFlags.keyframe = false;
            updateElements(updatedKeyframe, HistoryActions.CHANGED_KEYFRAME);
        }

        if (updatedHidden.length) {
            updatedHidden.forEach((el) => { el.updateFlags.hidden = true; });
            updateElements(updatedHidden, HistoryActions.CHANGED_HIDDEN, 'hidden');
        }

        if (updatedLock.length) {
            updatedLock.forEach((el) => { el.updateFlags.lock = true; });
            updateElements(updatedLock, HistoryActions.CHANGED_LOCK, 'lock');
        }

        const result = Track.prototype.save.call(this, frame, data);
        return result;
    }

    protected getPosition(
        targetFrame: number, leftKeyframe: number | null, rightKeyframe: number | null,
    ): Omit<InterpolatedPosition, 'points'> & { keyframe: boolean } {
        const leftFrame = targetFrame in this.shapes ? targetFrame : leftKeyframe;
        const rightPosition = Number.isInteger(rightKeyframe) ? this.shapes[rightKeyframe] : null;
        const leftPosition = Number.isInteger(leftFrame) ? this.shapes[leftFrame] : null;

        if (leftPosition && rightPosition) {
            return {
                rotation: 0,
                occluded: leftPosition.occluded,
                outside: leftPosition.outside,
                zOrder: leftPosition.zOrder,
                keyframe: targetFrame in this.shapes,
            };
        }

        const singlePosition = leftPosition || rightPosition;
        if (singlePosition) {
            return {
                rotation: 0,
                occluded: singlePosition.occluded,
                zOrder: singlePosition.zOrder,
                keyframe: targetFrame in this.shapes,
                outside: singlePosition === rightPosition ? true : singlePosition.outside,
            };
        }

        throw new DataError(
            'No one left position or right position was found. ' +
                `Interpolation impossible. Client ID: ${this.clientID}`,
        );
    }
}

Object.defineProperty(RectangleTrack, 'distance', { value: RectangleShape.distance });
Object.defineProperty(PolygonTrack, 'distance', { value: PolygonShape.distance });
Object.defineProperty(PolylineTrack, 'distance', { value: PolylineShape.distance });
Object.defineProperty(PointsTrack, 'distance', { value: PointsShape.distance });
Object.defineProperty(EllipseTrack, 'distance', { value: EllipseShape.distance });
Object.defineProperty(CuboidTrack, 'distance', { value: CuboidShape.distance });
Object.defineProperty(SkeletonTrack, 'distance', { value: SkeletonShape.distance });

export function shapeFactory(data: RawShapeData, clientID: number, injection: AnnotationInjection): Shape {
    const { type } = data;
    const color = colors[clientID % colors.length];

    let shapeModel = null;
    switch (type) {
        case ShapeType.RECTANGLE:
            shapeModel = new RectangleShape(data, clientID, color, injection);
            break;
        case ShapeType.POLYGON:
            shapeModel = new PolygonShape(data, clientID, color, injection);
            break;
        case ShapeType.POLYLINE:
            shapeModel = new PolylineShape(data, clientID, color, injection);
            break;
        case ShapeType.POINTS:
            shapeModel = new PointsShape(data, clientID, color, injection);
            break;
        case ShapeType.ELLIPSE:
            shapeModel = new EllipseShape(data, clientID, color, injection);
            break;
        case ShapeType.CUBOID:
            shapeModel = new CuboidShape(data, clientID, color, injection);
            break;
        case ShapeType.MASK:
            shapeModel = new MaskShape(data, clientID, color, injection);
            break;
        case ShapeType.SKELETON:
            shapeModel = new SkeletonShape(data, clientID, color, injection);
            break;
        default:
            throw new DataError(`An unexpected type of shape "${type}"`);
    }

    return shapeModel;
}

export function trackFactory(trackData: RawTrackData, clientID: number, injection: AnnotationInjection): Track {
    if (trackData.shapes.length) {
        const { type } = trackData.shapes[0];
        const color = colors[clientID % colors.length];

        let trackModel = null;
        switch (type) {
            case ShapeType.RECTANGLE:
                trackModel = new RectangleTrack(trackData, clientID, color, injection);
                break;
            case ShapeType.POLYGON:
                trackModel = new PolygonTrack(trackData, clientID, color, injection);
                break;
            case ShapeType.POLYLINE:
                trackModel = new PolylineTrack(trackData, clientID, color, injection);
                break;
            case ShapeType.POINTS:
                trackModel = new PointsTrack(trackData, clientID, color, injection);
                break;
            case ShapeType.ELLIPSE:
                trackModel = new EllipseTrack(trackData, clientID, color, injection);
                break;
            case ShapeType.CUBOID:
                trackModel = new CuboidTrack(trackData, clientID, color, injection);
                break;
            case ShapeType.SKELETON:
                trackModel = new SkeletonTrack(trackData, clientID, color, injection);
                break;
            default:
                throw new DataError(`An unexpected type of track "${type}"`);
        }

        return trackModel;
    }

    console.warn('The track without any shapes had been found. It was ignored.');
    return null;
}
