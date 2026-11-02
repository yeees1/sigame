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

## Автодеплой на сервер

Workflow `.github/workflows/deploy.yml` запускает тесты при каждом push в `main`. После включения переменной `AUTO_DEPLOY_ENABLED=true` он по SSH обновляет `/srv/apps/sigame` и выполняет `docker compose build app` и `docker compose up`. На сервере должен уже работать Docker Compose с сервисом `app` в этой папке. Сборка выполняется на сервере.

Перезапуск Node.js удаляет все комнаты из памяти. Поэтому workflow проверяет `/health` до сборки и прямо перед перезапуском: если есть незавершённая игра, деплой прекращается. После завершения игры запустите неудавшийся workflow повторно через **Actions → Deploy → Re-run jobs**. Не запускайте несколько деплоев вручную одновременно.

Сначала один раз обновите сервер вручную **между играми**, чтобы на нём появился счётчик активных игр:

```sh
cd /srv/apps/sigame
git pull --ff-only
docker compose up -d --build --wait
```

Создайте отдельный SSH-ключ для GitHub Actions на своём компьютере и добавьте его публичную часть на сервер (замените `SERVER_IP` на IP сервера, а `root` на пользователя с доступом к Docker и папке проекта):

```sh
ssh-keygen -t ed25519 -f ~/.ssh/sigame_actions -N '' -C sigame-actions
cat ~/.ssh/sigame_actions.pub | ssh root@SERVER_IP 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'
ssh-keyscan -t ed25519 -H SERVER_IP > /tmp/sigame_known_hosts
ssh root@SERVER_IP 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'
ssh-keygen -lf /tmp/sigame_known_hosts
```

Сверьте отпечатки в последних двух командах. В GitHub откройте **Settings → Secrets and variables → Actions** и создайте четыре *Repository secrets*:

| Имя | Значение |
| --- | --- |
| `DEPLOY_HOST` | IP или имя сервера, совпадающее с записью в `known_hosts` |
| `DEPLOY_USER` | Пользователь SSH, например `root` |
| `DEPLOY_SSH_KEY` | Полное содержимое приватного ключа `~/.ssh/sigame_actions` |
| `DEPLOY_KNOWN_HOSTS` | Полное содержимое `/tmp/sigame_known_hosts` |

Приватный ключ не добавляйте в репозиторий. Затем на вкладке *Variables* создайте `AUTO_DEPLOY_ENABLED` со значением `true`. Проверьте настройку через **Actions → Deploy → Run workflow**. Последующие push в `main` будут запускать деплой автоматически. Если серверная папка содержит локальные изменения отслеживаемых Git файлов или приложение не отвечает на `/health`, workflow остановится без перезапуска.

