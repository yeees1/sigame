## Запуск

```sh
npm ci
npm start
```

## Docker

```sh
docker build -t pulse-quiz .
docker run --rm -p 3000:3000 -e PUBLIC_URL=https://quiz.example.com pulse-quiz
```

