#!/bin/sh

# Copyright (C) 2022 CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

set -e

GENERATOR_VERSION="v6.0.1"

VERSION="2.3.0"
LIB_NAME="cvat_sdk"
LAYER1_LIB_NAME="${LIB_NAME}/api_client"
DST_DIR="."
TEMPLATE_DIR="gen"
POST_PROCESS_SCRIPT="${TEMPLATE_DIR}/postprocess.py"

mkdir -p "${DST_DIR}/"
rm -f -r "${DST_DIR}/docs" "${DST_DIR}/${LAYER1_LIB_NAME}" "requirements/"
cp "${TEMPLATE_DIR}/templates/openapi-generator/.openapi-generator-ignore" "${DST_DIR}/"

# Pass template dir here
# https://github.com/OpenAPITools/openapi-generator/issues/8420
docker run --rm -v "$PWD":"/local" -u "$(id -u)":"$(id -g)" \
    openapitools/openapi-generator-cli:${GENERATOR_VERSION} generate \
        -t "/local/${TEMPLATE_DIR}/templates/openapi-generator/" \
        -i "/local/schema/schema.yml" \
        --config "/local/${TEMPLATE_DIR}/generator-config.yml" \
        -g python \
        -o "/local/${DST_DIR}/"

sed -e "s|{{packageVersion}}|${VERSION}|g" "${TEMPLATE_DIR}/templates/version.py.template" > "${DST_DIR}/${LIB_NAME}/version.py"
cp -r "${TEMPLATE_DIR}/templates/requirements" "${DST_DIR}/"
cp -r "${TEMPLATE_DIR}/templates/MANIFEST.in" "${DST_DIR}/"
mv "${DST_DIR}/requirements.txt" "${DST_DIR}/requirements/api_client.txt"

# Do custom postprocessing for code files
"${POST_PROCESS_SCRIPT}" --schema "schema/schema.yml" --input-path "${DST_DIR}/${LIB_NAME}"

# Do custom postprocessing for docs files
"${POST_PROCESS_SCRIPT}" --schema "schema/schema.yml" --input-path "${DST_DIR}/docs" --file-ext '.md'
"${POST_PROCESS_SCRIPT}" --schema "schema/schema.yml" --input-path "${DST_DIR}/README.md"

API_DOCS_DIR="${DST_DIR}/docs/apis/"
MODEL_DOCS_DIR="${DST_DIR}/docs/models/"
mkdir "${API_DOCS_DIR}"
mkdir "${MODEL_DOCS_DIR}"
mv "${DST_DIR}/docs/"*Api.md "${API_DOCS_DIR}"
mv "${DST_DIR}/docs/"*.md "${MODEL_DOCS_DIR}"
mv "${DST_DIR}/README.md" "${DST_DIR}/docs/"

cp "${TEMPLATE_DIR}/templates/README.md.template" "${DST_DIR}/README.md"
