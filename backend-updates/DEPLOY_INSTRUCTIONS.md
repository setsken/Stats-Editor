# 🚀 Инструкция по обновлению бэкенда

## Шаг 1: Скопировать обновлённые файлы

Скопируйте файлы из папки `backend-updates` в `of-stats-backend`:

```
backend-updates/auth.js → of-stats-backend/src/routes/auth.js
backend-updates/presets.js → of-stats-backend/src/routes/presets.js
backend-updates/fans-trend.js → of-stats-backend/src/routes/fans-trend.js  ← НОВЫЙ
backend-updates/alerts.js → of-stats-backend/src/routes/alerts.js  ← НОВЫЙ
backend-updates/notes.js → of-stats-backend/src/routes/notes.js  ← НОВЫЙ
backend-updates/database.js → of-stats-backend/src/config/database.js
backend-updates/package.json → of-stats-backend/package.json
backend-updates/migrate-fans.js → of-stats-backend/src/config/migrate-fans.js
```

## Шаг 1.1: Подключить fans-trend роут в index.js

Откройте `of-stats-backend/src/index.js` и найдите где подключаются `/api/fans` роуты.

**Замените** существующее подключение fans роутов на:

```javascript
app.use('/api/fans', require('./routes/fans-trend'));
```

> Файл `fans-trend.js` объединяет все 4 эндпоинта:
> - `POST /fans/report` — оригинальный + UPSERT в model_fans_daily
> - `GET /fans/trend/:username` — **НОВЫЙ** — история фанов для графика
> - `GET /fans/:username` — последнее известное кол-во фанов
> - `POST /fans/batch` — пакетный запрос фанов
>
> Таблица `model_fans_daily` создаётся автоматически при старте через `initDatabase()`.

## Шаг 1.2: Подключить alerts роут в index.js

Добавьте в `of-stats-backend/src/index.js`:

```javascript
app.use('/api/alerts', require('./routes/alerts'));
```

> Эндпоинты:
> - `POST /alerts/report` — плагин отправляет обнаруженные аномалии (публичный, без авторизации)
> - `GET /alerts/:username` — получить все алерты для модели (публичный, все пользователи видят)
>
> Таблица `model_alerts` создаётся автоматически при старте через `initDatabase()`.

## Шаг 1.3: Подключить notes роут в index.js

Добавьте в `of-stats-backend/src/index.js`:

```javascript
app.use('/api/notes', require('./routes/notes'));
```

> Эндпоинты (все требуют авторизации):
> - `GET /notes` — получить все заметки пользователя
> - `PUT /notes/sync` — полная синхронизация всех заметок
> - `PUT /notes/:username` — сохранить заметку для модели
> - `DELETE /notes/:username` — удалить заметку
> - `GET /notes/tags` — получить теги пользователя
> - `PUT /notes/tags` — синхронизировать теги
>
> Таблицы `user_notes` и `user_tags` создаются автоматически при старте через `initDatabase()`.

## Шаг 1.5: Запустить миграцию для очистки дубликатов fans

После деплоя выполните в Railway Shell:

```bash
node src/config/migrate-fans.js
```

Или через npm:
```bash
npm run migrate-fans
```

Это удалит все дубликаты из model_fans_history и добавит уникальное ограничение.

## Шаг 2: Добавить переменные в Railway

Откройте https://railway.app → Ваш проект → Variables

Добавьте новые переменные для SMTP (email):

### Для Gmail:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=ваш-email@gmail.com
SMTP_PASS=ваш-app-password
SMTP_FROM=Stats Editor Pro <ваш-email@gmail.com>
```

### Как получить App Password для Gmail:
1. Откройте https://myaccount.google.com/security
2. Включите двухфакторную аутентификацию (если не включена)
3. Перейдите в "Пароли приложений" (App passwords)
4. Создайте новый пароль для "Mail" → "Other (Custom name)" → "Stats Editor"
5. Скопируйте 16-значный пароль в SMTP_PASS

## Шаг 3: Задеплоить на Railway

### Вариант A: Через Git (рекомендуется)
```bash
cd of-stats-backend
git add .
git commit -m "Add password reset and email notifications"
git push origin main
```

Railway автоматически задеплоит.

### Вариант B: Через Railway CLI
```bash
railway up
```

## Шаг 4: Проверить работу

После деплоя проверьте API:
```
https://stats-editor-production.up.railway.app/api/auth/login
```

---

## 📊 Схема базы данных

### Таблица `users`
| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Primary key |
| email | VARCHAR(255) | Email пользователя (уникальный) |
| password_hash | VARCHAR(255) | Хэш пароля (bcrypt) |
| is_active | BOOLEAN | Активен ли аккаунт |
| email_verified | BOOLEAN | Подтверждён ли email |
| password_reset_token | VARCHAR(255) | Токен сброса пароля (хэш) |
| password_reset_expires | TIMESTAMP | Когда истекает токен |
| trial_started_at | TIMESTAMP | Начало триала |
| last_login_at | TIMESTAMP | Последний вход |
| created_at | TIMESTAMP | Дата регистрации |

### Таблица `subscriptions`
| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Primary key |
| user_id | INTEGER | FK → users |
| plan | VARCHAR(50) | 'trial', 'basic', 'premium' |
| model_limit | INTEGER | Лимит моделей (10 или 50) |
| status | VARCHAR(50) | 'active', 'expired' |
| expires_at | TIMESTAMP | Когда истекает |

### Таблица `user_models`
| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Primary key |
| user_id | INTEGER | FK → users |
| model_username | VARCHAR(255) | Username модели |
| display_name | VARCHAR(255) | Отображаемое имя |
| added_at | TIMESTAMP | Когда добавлена |

### Таблица `model_alerts` (НОВАЯ)
| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Primary key |
| model_username | VARCHAR(255) | Username модели |
| alert_type | VARCHAR(50) | Тип алерта (fans_surge, fans_drop, likes_surge, likes_drop, score_up, score_down) |
| icon | VARCHAR(10) | Emoji иконка |
| color | VARCHAR(20) | HEX цвет |
| diff | VARCHAR(50) | Разница (например "+1,500") |
| pct | VARCHAR(20) | Процент (например "+3.2%") |
| extra_data | JSONB | Доп. данные (oldScore, newScore, oldGrade, newGrade) |
| alert_date | DATE | Дата алерта (для дедупликации) |
| created_at | TIMESTAMP | Когда создан |
| UNIQUE | | (model_username, alert_type, alert_date) |

### Таблица `user_notes` (НОВАЯ)
| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Primary key |
| user_id | INTEGER | FK → users |
| model_username | VARCHAR(255) | Username модели |
| note_text | TEXT | Текст заметки |
| tags | JSONB | Массив ID тегов |
| note_date | TIMESTAMP | Дата заметки |
| avatar_url | VARCHAR(500) | URL аватарки модели |
| created_at | TIMESTAMP | Когда создана |
| updated_at | TIMESTAMP | Когда обновлена |
| UNIQUE | | (user_id, model_username) |

### Таблица `user_tags` (НОВАЯ)
| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Primary key |
| user_id | INTEGER | FK → users |
| name | VARCHAR(50) | Название тега |
| color_index | INTEGER | Индекс цвета из палитры |
| created_at | TIMESTAMP | Когда создан |

---

## 🔄 Как работает привязка моделей

1. **Добавление модели:**
   - Пользователь вводит @username
   - `POST /api/models` → проверка лимита
   - Если лимит не превышен → `INSERT INTO user_models`

2. **Проверка лимита:**
   ```sql
   SELECT COUNT(*) FROM user_models WHERE user_id = ?
   SELECT model_limit FROM subscriptions WHERE user_id = ? AND status = 'active'
   ```
   Если count >= model_limit → ошибка "Model limit reached"

3. **Лимиты:**
   - Trial: 10 моделей
   - Basic ($30): 10 моделей
   - Premium ($50): 50 моделей

---

## 📧 Email уведомления

Система отправляет email в следующих случаях:
1. **Регистрация** - приветственное письмо
2. **Forgot Password** - код для сброса пароля

Если SMTP не настроен, система работает без email (пишет в логи).

---

## ☁️ Облачная синхронизация пресетов

### Шаг: Подключить роут в index.js

В файле `of-stats-backend/src/index.js` добавьте:

```javascript
// После строки с auth роутом:
const presetsRouter = require('./routes/presets');
app.use('/api/presets', presetsRouter);
```

### Таблица `user_presets`
| Поле | Тип | Описание |
|------|-----|----------|
| id | SERIAL | Primary key |
| user_id | INTEGER | FK → users |
| name | VARCHAR(100) | Имя пресета (уникально для каждого юзера) |
| preset_data | JSONB | Все настройки пресета (JSON) |
| active | BOOLEAN | Активный ли пресет |
| created_at | TIMESTAMP | Когда создан |
| updated_at | TIMESTAMP | Последнее обновление |

Таблица создаётся автоматически при старте через `initDatabase()`.

### API Endpoints

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/presets` | Получить все пресеты пользователя |
| PUT | `/api/presets/sync` | Полная синхронизация (отправить все пресеты) |
| PUT | `/api/presets/:name` | Сохранить/обновить один пресет |
| PUT | `/api/presets/active/:name` | Установить активный пресет |
| DELETE | `/api/presets/:name` | Удалить пресет |

### Как работает синхронизация

1. При открытии попапа — загружаются локальные пресеты (мгновенно)
2. Фоном идёт запрос на сервер за серверными пресетами
3. Если сервер имеет пресеты — они становятся основными (cloud-first)
4. Если сервер пустой, а локальные есть — пушатся на сервер
5. При сохранении/удалении пресета — изменения записываются локально И отправляются на сервер
6. Максимум 50 пресетов на пользователя

---

## 🔐 Безопасность

- Пароли хэшируются через bcrypt (10 rounds)
- JWT токены истекают через 7 дней
- Токены сброса пароля истекают через 1 час
- Токены сброса хранятся в хэшированном виде (SHA-256)

---

## 💬 Farmed Models — статус комментариев

### Шаг 1: Скопировать файл

```
backend-updates/farmed-models.js → of-stats-backend/src/routes/farmed-models.js
```

### Шаг 2: Подключить роут в index.js

В файле `of-stats-backend/src/index.js` добавьте:

```javascript
// После строки с presets роутом:
const farmedModelsRouter = require('./routes/farmed-models');
app.use('/api/farmed-models', farmedModelsRouter);
```

### Шаг 3: Добавить переменную окружения

В Railway → Variables добавьте:

```
FARMED_SYNC_KEY=ваш-секретный-ключ-для-синхронизации
```

Этот ключ нужен для POST `/api/farmed-models/sync` — загрузки данных из локальной БД.

### Шаг 4: Первая миграция данных

Для начальной загрузки из SQLite в PostgreSQL используйте:

```bash
cd backend-updates
DATABASE_URL=postgresql://... node migrate-farmed-models.js
```

### Шаг 5: Периодическая синхронизация

Для обновления данных запускайте:

```bash
FARMED_SYNC_KEY=... node sync-farmed-models.js
```

Можно настроить через Task Scheduler (Windows) для автоматического обновления.

### Таблица `farmed_models`
| Поле | Тип | Описание |
|------|-----|----------|
| username | VARCHAR(255) | Primary key, username модели |
| of_url | TEXT | Ссылка на OF профиль |
| found_at | TIMESTAMP | Когда модель найдена |
| status | VARCHAR(20) | 'ready' = комменты открыты, 'none' = закрыты, NULL = не проверено |

### API Endpoints

| Метод | URL | Auth | Описание |
|-------|-----|------|----------|
| GET | `/api/farmed-models/:username` | Нет | Проверить статус комментов модели |
| POST | `/api/farmed-models/bulk` | Нет | Проверить несколько моделей за раз (max 50) |
| POST | `/api/farmed-models/sync` | x-sync-key | Загрузить/обновить данные из Comenter |
