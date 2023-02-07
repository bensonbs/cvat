export CVAT_HOST=10.96.212.243

docker-compose \
    -f docker-compose.yml \
    -f components/serverless/docker-compose.serverless.yml up -d

docker-compose \
    -f docker-compose.yml \
    -f components/serverless/docker-compose.serverless.yml down

nuctl create project cvat

nuctl deploy \
--project-name cvat \
--path serverless/pytorch/ultralytics/yolov5/nuclio/ \
--volume `pwd`/serverless/common:/opt/nuclio/common \
--platform local --resource-limit nvidia.com/gpu=1

nuctl deploy \
--project-name cvat \
--path serverless/pytorch/ultralytics/yolov5_TC3/nuclio/ \
--volume `pwd`/serverless/common:/opt/nuclio/common \
--platform local --resource-limit nvidia.com/gpu=1

docker-compose \
    -f docker-compose.yml \
    -f docker-compose.override.yml \
    -f components/serverless/docker-compose.serverless.yml up -d