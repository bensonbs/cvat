export CVAT_HOST=10.96.212.243

docker-compose \
    -f docker-compose.yml \
    -f components/serverless/docker-compose.serverless.yml up -d

docker-compose \
    -f docker-compose.yml \
    -f components/serverless/docker-compose.serverless.yml down

nuctl create project cvat

# # yolov5 - 原生
# nuctl deploy \
# --project-name cvat \
# --path serverless/pytorch/ultralytics/yolov5/nuclio/ \
# --volume `pwd`/serverless/common:/opt/nuclio/common \
# --platform local --resource-limit nvidia.com/gpu=1

# # yolov5 - TC3防護具辨識
# nuctl deploy \
# --project-name cvat \
# --path serverless/pytorch/ultralytics/yolov5_TC3/nuclio/ \
# --volume `pwd`/serverless/common:/opt/nuclio/common \
# --platform local --resource-limit nvidia.com/gpu=1

# # yolov5 - 防護具辨識v2
# nuctl deploy \
# --project-name cvat \
# --path serverless/pytorch/ultralytics/yolov5_ppe/nuclio/ \
# --volume `pwd`/serverless/common:/opt/nuclio/common \
# --platform local --resource-limit nvidia.com/gpu=1

# # Segment Anything
# nuctl deploy \
# --project-name cvat \
# --path serverless/pytorch/facebookresearch/sam/nuclio/ \
# --volume `pwd`/serverless/common:/opt/nuclio/common \
# --platform local --resource-limit nvidia.com/gpu=1

# # transt
# nuctl deploy \
# --project-name cvat \
# --path serverless/pytorch/dschoerk/transt/nuclio/ \
# --volume `pwd`/serverless/common:/opt/nuclio/common \
# --platform local --resource-limit nvidia.com/gpu=1

# siammask
nuctl deploy \
--project-name cvat \
--path serverless/pytorch/foolwood/siammask/nuclio \
--volume `pwd`/serverless/common:/opt/nuclio/common \
--platform local --resource-limit nvidia.com/gpu=1

# # yolov7 - 原生
# nuctl deploy \
# --project-name cvat \
# --path serverless/onnx/WongKinYiu/yolov7/nuclio/ \
# --volume `pwd`/serverless/common:/opt/nuclio/common \
# --platform local --resource-limit nvidia.com/gpu=1

docker-compose \
    -f docker-compose.yml \
    -f docker-compose.override.yml \
    -f components/serverless/docker-compose.serverless.yml up -d