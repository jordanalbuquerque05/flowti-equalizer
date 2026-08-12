DD_API_KEY=fffbd81796398cb1cdb49c87bf21974b \
DD_SITE="us5.datadoghq.com" \
DD_APM_INSTRUMENTATION_ENABLED=host \
DD_DATA_STREAMS_ENABLED=true \
DD_PROFILING_ENABLED=auto \
DD_APM_INSTRUMENTATION_LIBRARIES=java:1,python:4,js:5,php:1,dotnet:3,ruby:2 \
DD_LOGS_CONFIG_PROCESS_COLLECT_ALL=true \
bash -c "$(curl -L https://install.datadoghq.com/scripts/install_script_agent7.sh)"
