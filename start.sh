export CVAT_HOST=10.96.212.243

docker-compose \
    -f docker-compose.yml \
    -f docker-compose.override.yml \
    -f components/serverless/docker-compose.serverless.yml down

docker-compose \
    -f docker-compose.yml \
    -f docker-compose.override.yml \
    -f components/serverless/docker-compose.serverless.yml up -d