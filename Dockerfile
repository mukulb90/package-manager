FROM node:14.16

WORKDIR /usr/src/app

COPY --chown=app:app ./ ./

RUN npm install
RUN npm run build

USER 2020

CMD ["npm", "run", "start"]
