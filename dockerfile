## Specifies the base image we're extending
FROM node:9

## Create base directory
RUN mkdir /source

## Specify the "working directory" for the rest of the Dockerfile
WORKDIR /source

## Install packages using NPM 5 (bundled with the node:9 image)
COPY ./package.json /source/package.json
COPY ./package-lock.json /source/package-lock.json
COPY ./certificate.pem /source/certificate.pem
COPY ./key.pem /source/key.pem

RUN npm install --silent

## Add application code
COPY ./lib /source/lib



## Set environment to "development" by default
##ENV NODE_ENV development

## Allows port 3000 to be publicly available
EXPOSE 443

## The command uses nodemon to run the application
CMD ["node", "start"]