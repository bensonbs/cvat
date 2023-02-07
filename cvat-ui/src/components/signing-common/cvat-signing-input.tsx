// Copyright (C) 2022 CVAT.ai Corporation
//
// SPDX-License-Identifier: MIT
import React, { useEffect, useState } from 'react';
import Icon from '@ant-design/icons';
import { ClearIcon } from 'icons';
import { Input } from 'antd';
import Text from 'antd/lib/typography/Text';

interface SocialAccountLinkProps {
    id?: string;
    autoComplete?: string;
    placeholder: string;
    value?: string;
    type?: CVATInputType;
    onReset?: () => void;
    onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

export enum CVATInputType {
    TEXT = 'text',
    PASSWORD = 'passord',
}

function CVATSigningInput(props: SocialAccountLinkProps): JSX.Element {
    const {
        id, autoComplete, type, onReset, placeholder, value, onChange,
    } = props;
    const [valueNonEmpty, setValueNonEmpty] = useState(false);
    useEffect((): void => {
        setValueNonEmpty(!!value);
    }, [value]);

    if (type === CVATInputType.PASSWORD) {
        return (
            <Input.Password
                value={value}
                autoComplete={autoComplete}
                className={valueNonEmpty ? 'cvat-input-floating-label-above' : 'cvat-input-floating-label'}
                prefix={<Text>{placeholder}</Text>}
                id={id}
                onChange={onChange}
            />
        );
    }
    return (
        <Input
            value={value}
            autoComplete={autoComplete}
            className={valueNonEmpty ? 'cvat-input-floating-label-above' : 'cvat-input-floating-label'}
            prefix={<Text>{placeholder}</Text>}
            id={id}
            suffix={valueNonEmpty && (
                <Icon
                    component={ClearIcon}
                    onClick={() => {
                        setValueNonEmpty(false);
                        if (onReset) onReset();
                    }}
                />
            )}
            onChange={onChange}
        />
    );
}

export default React.memo(CVATSigningInput);
